/**
 * The confined dsh path, end to end with real processes and no third-party
 * code: a stub dsh (a node script laid out as an npm package) runs a turn
 * against the fake provider through the pinned proxy, reaches the instance
 * through the relay, and is refused by the egress proxy. Seatbelt itself is
 * macOS-only, so the wrapper is injected here and its options are checked by
 * building the real profile from them; the host probe covers enforcement.
 */
import { jest } from '@jest/globals';
import { spawn as spawnReal } from 'child_process';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import dsh, { developerToolsDir, isConfinedDsh, TESTED_DSH_VERSIONS } from '../src/lib/adapters/dsh.js';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';
import { OWN_PROCESS_GROUP } from '@commonlyai/seats/process-group';
import { superviseRun } from '@commonlyai/seats/supervisor';
import { createTraceStore } from '@commonlyai/seats/trace/store';
import { startFakeProvider } from '../../packages/seats/test-support/fake-provider.js';
import { isRunning, readPid, reap, waitFor } from '../../packages/seats/test-support/processes.js';

const PIN = 'deepseek-flash-1017';
const CONFINED = { mode: 'workspace', network: { policy: 'restricted' } };

// Runs in the workspace (dsh's child env is closed, so it reports there).
// Reads its patch, makes one completion through the proxy it was given, then
// probes the relay and the egress proxy, and reports what it saw.
const STUB = String.raw`#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('dsh ${TESTED_DSH_VERSIONS[0]}\n'); process.exit(0); }
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const rows = JSON.parse(fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8'));
const prompt = args[args.length - 1];
if (prompt.includes('[[hang]]')) {
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync('.stub-grandchild.pid', String(child.pid));
  setInterval(() => {}, 1000);
  return;
}
const provider = rows.find((row) => row.id === 'llm-pi-ai').config.providers.commonly;
const pinned = rows.find((row) => row.id === 'agent-default-model').config.model;
const mcp = rows.at(-1).insert[0].config;
const asked = /\[\[model:([^\]]+)\]\]/.exec(prompt)?.[1] || pinned;
const connect = (target) => new Promise((resolve) => {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: target });
  request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
  request.on('error', (error) => resolve(error.message));
  request.end();
});
(async () => {
  const response = await fetch(provider.baseURL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env[provider.apiKeyEnv], 'content-type': 'application/json' },
    body: JSON.stringify({ model: asked, messages: [{ role: 'user', content: prompt }] }),
  });
  const body = await response.text();
  const relay = await fetch(mcp.env.COMMONLY_API_URL + '/api/health').then((r) => r.text(), (e) => e.message);
  const egress = process.env.HTTPS_PROXY ? await connect('exfil.example:443') : null;
  fs.writeFileSync('.stub-report.json', JSON.stringify({
    status: response.status, relay, egress, mcp,
    sandboxPolicy: rows.find((row) => row.id === 'sandbox-policy').config,
    env: { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, TMPDIR: process.env.TMPDIR, DEVELOPER_DIR: process.env.DEVELOPER_DIR },
  }));
  emit({ type: 'session', sessionId: 'session-11111111-1111-1111-1111-111111111111' });
  if (!response.ok) { emit({ type: 'error', message: 'provider said ' + response.status }); process.exit(1); }
  emit({ type: 'final', text: JSON.parse(body).choices[0].message.content });
})();
`;

const withSeat = async (fn, { provider: providerOptions = {} } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-confined-'));
  const cwd = join(root, 'workspace');
  const home = join(root, 'dsh-home');
  const pkg = join(root, 'prefix', 'node_modules', '@deepseek-ai', 'dsh');
  const mcpDir = join(root, 'mcp-home', '0.3.20');
  const mcpPkg = join(mcpDir, 'node_modules', '@commonlyai', 'mcp');
  await Promise.all([cwd, join(pkg, 'lib'), join(root, 'prefix', 'bin'), join(mcpPkg, 'src')]
    .map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.2"}');
  await writeFile(join(pkg, 'lib', 'bin.js'), STUB);
  await chmod(join(pkg, 'lib', 'bin.js'), 0o755);
  await symlink(join(pkg, 'lib', 'bin.js'), join(root, 'prefix', 'bin', 'dsh'));
  await writeFile(join(mcpPkg, 'package.json'), '{"name":"@commonlyai/mcp","version":"0.3.20"}');
  await writeFile(join(mcpPkg, 'src', 'index.js'), '');
  const keyFile = join(root, 'provider-key');
  await writeFile(keyFile, 'upstream-secret-123', { mode: 0o600 });

  const instanceSeen = [];
  const instance = createServer((request, response) => { instanceSeen.push(request.url); response.end('instance-ok'); });
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const provider = await startFakeProvider({ model: PIN, ...providerOptions });
  const wraps = [];
  const report = join(cwd, '.stub-report.json');
  const ctx = {
    cwd, _dshHome: home, _dshBinary: join(root, 'prefix', 'bin', 'dsh'), agentName: 'dsh-confined',
    runtimeToken: 'cm_agent_secret-123', instanceUrl: `http://127.0.0.1:${instance.address().port}`,
    env: { PATH: process.env.PATH },
    environment: {
      model: PIN, provider: { id: 'deepseek', baseURL: provider.baseURL, keyFile }, sandbox: CONFINED,
    },
    _platform: 'darwin',
    _detectSeatbelt: () => ({ available: true, path: '/usr/bin/sandbox-exec' }),
    // The stub runs unwrapped: the options are what is under test here.
    _wrapArgvWithSeatbelt: (inner, options) => { wraps.push({ inner, options }); return inner; },
    _prepareMcpSpawn: (command, options) => {
      wraps.push({ prepared: command, prepareOptions: options });
      return ['node', join(mcpPkg, 'src', 'index.js')];
    },
    _selectedMcpVersionDir: () => mcpDir,
    _developerToolsDir: () => null,
  };
  try {
    await fn({
      ctx, root, wraps, provider, instanceSeen, pkg, mcpDir, home,
      report: () => JSON.parse(readFileSync(report, 'utf8')),
    });
  } finally {
    await provider.close();
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
};

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

test('a confined writer gets the developer tools read-only, so git works inside the sandbox (D106)', async () => {
  await withSeat(async ({ ctx, wraps, pkg, mcpDir, root, report }) => {
    const tools = join(root, 'CommandLineTools');
    mkdirSync(tools);
    await dsh.spawn('[[reply:git-ok]]', { ...ctx, _developerToolsDir: () => tools });
    const { options } = wraps.find((entry) => entry.inner);
    expect(options.readOnlyDirectories).toEqual([realpathSync(join(pkg, '..', '..')), mcpDir, tools]);
    // Read-only: the grant never widens what the seat can write.
    expect(buildSeatbeltProfile(options).split('\n').filter((line) => line.includes(tools) && line.includes('file-write'))).toEqual([]);
    expect(report().env.DEVELOPER_DIR).toBe(tools);
  });
});

test('developerToolsDir: the declared or selected dir when it exists, null otherwise', () => {
  const real = realpathSync(tmpdir());
  expect(developerToolsDir({ env: { DEVELOPER_DIR: tmpdir() }, run: () => { throw new Error('not called'); } })).toBe(real);
  expect(developerToolsDir({ env: {}, run: () => ({ stdout: `${tmpdir()}\n` }) })).toBe(real);
  expect(developerToolsDir({ env: {}, run: () => ({ stdout: '' }) })).toBeNull();
  expect(developerToolsDir({ env: {}, run: () => ({ stdout: 'relative/dir\n' }) })).toBeNull();
  expect(developerToolsDir({ env: { DEVELOPER_DIR: '/nonexistent/dev-tools' } })).toBeNull();
});

test('a confined turn runs through the pinned proxy, the relay and the egress fence', async () => {
  await withSeat(async ({ ctx, wraps, provider, instanceSeen, pkg, mcpDir, home, report }) => {
    const result = await dsh.spawn('[[reply:confined-ok]]', ctx);
    expect(result).toEqual({ text: 'confined-ok', newSessionId: 'session-11111111-1111-1111-1111-111111111111' });

    const seen = report();
    expect(seen.status).toBe(200);
    expect(provider.requests.map((request) => request.model)).toEqual([PIN]);
    // The relay reached the instance; the MCP was handed the relay, not the instance.
    expect(seen.relay).toBe('instance-ok');
    expect(instanceSeen).toEqual(['/api/health']);
    expect(seen.mcp.env.COMMONLY_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.mcp.env.COMMONLY_API_URL).not.toBe(ctx.instanceUrl);
    expect(seen.mcp.command).toBe(process.execPath);
    // The egress proxy is live and refuses what is not on its list.
    expect(seen.egress).toBe(403);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exfil.example:443 (not allowlisted)'));
    expect(seen.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.env.NO_PROXY).toBe('127.0.0.1,localhost');
    expect(seen.env.TMPDIR).toBe(join(home, 'tmp'));
    expect(seen.sandboxPolicy).toEqual({ mode: 'danger-full-access', workspaceRoot: ctx.cwd });

    const prepared = wraps.find((entry) => entry.prepared);
    expect(prepared.prepareOptions).toEqual({ apiUrl: ctx.instanceUrl, publicSeat: true });
    const { inner, options } = wraps.find((entry) => entry.inner);
    expect(inner.slice(0, 2)).toEqual([process.execPath, realpathSync(join(pkg, 'lib', 'bin.js'))]);
    expect(options).toMatchObject({
      workspacePath: ctx.cwd, workspaceAccess: 'write', executablePath: process.execPath,
      statePath: home, network: 'loopback',
      readOnlyDirectories: [realpathSync(join(pkg, '..', '..')), mcpDir],
    });
    const ports = options.loopbackNetworkPorts;
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    expect(ports).toContain(Number(new URL(seen.env.HTTPS_PROXY).port));
    expect(ports).toContain(Number(new URL(seen.mcp.env.COMMONLY_API_URL).port));

    // The profile those options build: loopback only, those three ports.
    const profile = buildSeatbeltProfile(options);
    expect(profile).not.toMatch(/^\(allow network-outbound\)$/m);
    expect(profile).not.toContain('com.apple.SecurityServer');
    expect(profile.split('\n').filter((line) => line.includes('network-outbound')).sort())
      .toEqual(ports.map((port) => `(allow network-outbound (remote tcp "localhost:${port}"))`).sort());
  });
});

test('a response naming another model fails the turn as a broken pin', async () => {
  await withSeat(async ({ ctx, report }) => {
    await expect(dsh.spawn('hello', ctx)).rejects.toThrow(/served model check failed: served model "deepseek-pro-other" is not the pinned "deepseek-flash-1017"/);
    expect(report().status).toBe(502);
  }, { provider: { servedModel: 'deepseek-pro-other' } });
});

test('a request for another model is refused before the provider and fails the turn', async () => {
  await withSeat(async ({ ctx, provider, report }) => {
    await expect(dsh.spawn('[[model:deepseek-pro-other]] hi', ctx))
      .rejects.toThrow(/1 request\(s\) for a model other than deepseek-flash-1017 refused/);
    expect(report().status).toBe(403);
    expect(provider.requests).toEqual([]);
  });
});

test('confinement fails closed before any child starts', async () => {
  await withSeat(async ({ ctx, root }) => {
    const spawned = jest.fn();
    const cases = [
      [{ _platform: 'linux' }, /macOS only/],
      [{ _detectSeatbelt: () => ({ available: false, error: 'no sandbox-exec' }) }, /needs Seatbelt: no sandbox-exec/],
      [{ _prepareMcpSpawn: () => null }, /warmed Commonly MCP build/],
      [{ _selectedMcpVersionDir: () => null }, /warmed Commonly MCP build/],
    ];
    for (const [override, message] of cases) {
      await expect(dsh.spawn('hi', { ...ctx, ...override, _spawnImpl: spawned })).rejects.toThrow(message);
    }
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.cwd, '.stub-report.json'))).toBe(false);
  });
});

test('only the one confined shape is accepted', () => {
  expect(isConfinedDsh({})).toBe(false);
  expect(isConfinedDsh({ sandbox: CONFINED })).toBe(true);
  for (const sandbox of [
    { mode: 'workspace' },
    { mode: 'workspace', network: { policy: 'unrestricted' } },
    { mode: 'workspace', network: { policy: 'restricted', 'allow-hosts': ['evil.example'] } },
    { ...CONFINED, filesystem: { 'write-outside': ['/'] } },
    { mode: 'read-only', network: { policy: 'restricted' } },
    { mode: 'bwrap', network: { policy: 'restricted' } },
  ]) {
    expect(() => isConfinedDsh({ sandbox })).toThrow(/one confined shape/);
  }
  expect(() => isConfinedDsh({ sandbox: { ...CONFINED, trust: 'public' } })).toThrow(/public-trust/);
});

test('an unconfined seat keeps its old spawn: no wrap, no fence, no pin', async () => {
  await withSeat(async ({ ctx, wraps, report }) => {
    const { sandbox, ...environment } = ctx.environment;
    const result = await dsh.spawn('[[model:any-model]] hi', { ...ctx, environment });
    expect(result.text).toBe('PONG');
    expect(wraps).toEqual([]);
    const seen = report();
    expect(seen.env.HTTPS_PROXY).toBeUndefined();
    expect(seen.egress).toBeNull();
    expect(seen.mcp.env.COMMONLY_API_URL).toBe(ctx.instanceUrl);
    expect(seen.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: ctx.cwd });
  });
});

(process.platform === 'win32' ? test.skip : test)('a supervised confined turn that stalls is killed with what it started', async () => {
  await withSeat(async ({ ctx, root }) => {
    const store = createTraceStore({ root: join(root, 'trace') });
    let grandchild;
    try {
      const pending = superviseRun({
        adapter: dsh, prompt: '[[hang]]', ctx, store,
        policy: { stallMs: 400, cancelGraceMs: 300, timeoutMs: 20000 },
      });
      grandchild = await readPid(join(ctx.cwd, '.stub-grandchild.pid'));
      expect(isRunning(grandchild)).toBe(true);
      const out = await pending;
      expect(out.outcome).toBe('stuck');
      expect(await waitFor(() => !isRunning(grandchild))).toBe(true);
    } finally {
      if (grandchild) reap(grandchild);
    }
  });
}, 20000);

test('the supervisor flag is what puts a dsh child in its own group', async () => {
  await withSeat(async ({ ctx }) => {
    const calls = [];
    const record = (flag) => ({
      ...ctx,
      ...(flag ? { [OWN_PROCESS_GROUP]: true } : {}),
      _spawnImpl: (command, args, options) => {
        calls.push(options);
        return spawnReal(command, args, options);
      },
    });
    await dsh.spawn('hi', record(false));
    await dsh.spawn('hi', record(true));
    expect(Object.hasOwn(calls[0], 'detached')).toBe(false);
    expect(calls[1].detached).toBe(process.platform !== 'win32');
  });
});
