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
import { createHash } from 'crypto';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import dsh, {
  developerToolsDir, DSH_PUBLIC_DISABLED_PLUGINS, DSH_PUBLIC_GUARD_SERVICE, isConfinedDsh, isPublicDsh, PUBLIC_TURN_DIR, seatHome, WITHHELD_TOOLS_MCP_ENV,
  systemToolsFirst, TESTED_DSH_VERSIONS,
} from '../src/lib/adapters/dsh.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS, publicSeatWithheldTools } from '../src/lib/public-withheld-tools.js';
import { buildSeatbeltProfile } from '../src/lib/sandbox/seatbelt.js';
import { OWN_PROCESS_GROUP } from '@commonlyai/seats/process-group';
import { superviseRun } from '@commonlyai/seats/supervisor';
import { createTraceStore } from '@commonlyai/seats/trace/store';
import { startFakeProvider } from '../../packages/seats/test-support/fake-provider.js';
import { isRunning, readPids, reap, waitFor } from '../../packages/seats/test-support/processes.js';

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
  fs.writeFileSync('.stub-pids', process.pid + ',' + child.pid);
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
    status: response.status, relay, egress, mcp, rows, cwd: process.cwd(),
    sandboxPolicy: rows.find((row) => row.id === 'sandbox-policy').config,
    env: { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, TMPDIR: process.env.TMPDIR, DEVELOPER_DIR: process.env.DEVELOPER_DIR, PATH: process.env.PATH },
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

test('a confined writer gets the developer tools read-only, so git works inside the sandbox', async () => {
  await withSeat(async ({ ctx, wraps, pkg, mcpDir, root, report }) => {
    const tools = join(root, 'CommandLineTools');
    mkdirSync(tools);
    await dsh.spawn('[[reply:git-ok]]', { ...ctx, _developerToolsDir: () => tools });
    const { options } = wraps.find((entry) => entry.inner);
    expect(options.readOnlyDirectories).toEqual([realpathSync(join(pkg, '..', '..')), mcpDir, tools]);
    // Read-only: the grant never widens what the seat can write.
    expect(buildSeatbeltProfile(options).split('\n').filter((line) => line.includes(tools) && line.includes('file-write'))).toEqual([]);
    expect(report().env.DEVELOPER_DIR).toBe(tools);
    // Bare `git` must be the shim the grant serves, not a Homebrew git ahead of it.
    expect(report().env.PATH).toBe(systemToolsFirst(process.env.PATH));
  });
});

test('systemToolsFirst puts /usr/bin ahead of Homebrew and keeps the rest in order', () => {
  expect(systemToolsFirst('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')).toBe('/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin');
  expect(systemToolsFirst('/opt/homebrew/bin:/bin')).toBe('/usr/bin:/opt/homebrew/bin:/bin');
  expect(systemToolsFirst('')).toBe('/usr/bin');
  expect(systemToolsFirst(undefined)).toBe('/usr/bin');
});

test('developerToolsDir: the declared or selected dir when it is an Apple tools location', () => {
  const at = (paths) => ({ exists: (dir) => dir in paths, realpath: (dir) => paths[dir] });
  const CLT = '/Library/Developer/CommandLineTools';
  const XCODE = '/Applications/Xcode.app/Contents/Developer';
  const fs = at({ [CLT]: CLT, [XCODE]: XCODE, '/Applications/Xcode-beta.app': '/Applications/Xcode-beta.app' });
  expect(developerToolsDir({ env: { DEVELOPER_DIR: CLT }, run: () => { throw new Error('not called'); }, ...fs })).toBe(CLT);
  expect(developerToolsDir({ env: {}, run: () => ({ stdout: `${XCODE}\n` }), ...fs })).toBe(XCODE);
  expect(developerToolsDir({ env: {}, run: () => ({ stdout: '' }), ...fs })).toBeNull();
  expect(developerToolsDir({ env: {}, run: () => ({ stdout: 'relative/dir\n' }), ...fs })).toBeNull();
  expect(developerToolsDir({ env: { DEVELOPER_DIR: '/nonexistent/dev-tools' }, ...fs })).toBeNull();
  // A link into an Apple location is judged by where it lands.
  expect(developerToolsDir({ env: { DEVELOPER_DIR: '/opt/tools' }, ...at({ '/opt/tools': CLT }) })).toBe(CLT);
});

test('developerToolsDir refuses any other directory, so DEVELOPER_DIR cannot widen the sandbox', () => {
  const real = (dir) => developerToolsDir({ env: { DEVELOPER_DIR: dir }, run: () => { throw new Error('not called'); } });
  expect(real('/')).toBeNull();
  expect(real(homedir())).toBeNull();
  expect(real(tmpdir())).toBeNull();
  const linked = (target) => developerToolsDir({
    env: { DEVELOPER_DIR: '/Library/Developer/CommandLineTools' }, exists: () => true, realpath: () => target,
  });
  expect(linked('/')).toBeNull();
  expect(linked('/Library/Developer/CommandLineTools/..')).toBeNull();
  expect(linked('/Applications/Xcode.app')).toBeNull();
  expect(linked('/Applications/Xcode.app/Contents/Developer/usr')).toBeNull();
  expect(linked('/Users/x/Applications/Xcode.app/Contents/Developer')).toBeNull();
});

test('a confined turn runs through the pinned proxy, the relay and the egress fence', async () => {
  await withSeat(async ({ ctx, wraps, provider, instanceSeen, pkg, mcpDir, home, report }) => {
    const result = await dsh.spawn('[[reply:confined-ok]]', ctx);
    expect(result).toEqual({ text: 'confined-ok', newSessionId: 'session-11111111-1111-1111-1111-111111111111', contextTokens: null });

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
    // A private seat's workspace is the operator's folder, and a link there may be theirs.
    expect(options.pinWorkspace).toBe(false);
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
    // The stub and the grandchild it starts. Both are reaped at the end: a
    // stub the supervisor failed to kill once outlived this test by eight days,
    // orphaned to init with its folder already deleted (F466).
    let pids = [];
    try {
      const pending = superviseRun({
        adapter: dsh, prompt: '[[hang]]', ctx, store,
        policy: { stallMs: 400, cancelGraceMs: 300, timeoutMs: 20000 },
      });
      pids = await readPids(join(ctx.cwd, '.stub-pids'), 2);
      const [stub, grandchild] = pids;
      expect(isRunning(grandchild)).toBe(true);
      const out = await pending;
      expect(out.outcome).toBe('stuck');
      expect(await waitFor(() => !isRunning(grandchild))).toBe(true);
      expect(await waitFor(() => !isRunning(stub))).toBe(true);
    } finally {
      pids.forEach(reap);
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

describe('F115: a public dsh turn offers the model only the Commonly tools a public seat may use', () => {
  const PUBLIC = { trust: 'public' };
  const publicSeat = (ctx, extra = {}) => ({
    ...ctx, ...extra, environment: { ...ctx.environment, sandbox: PUBLIC, ...(extra.environment || {}) },
  });
  const turnDir = (home) => join(home, PUBLIC_TURN_DIR);
  const readReport = (home) => JSON.parse(readFileSync(join(turnDir(home), '.stub-report.json'), 'utf8'));

  test('public trust is confined: bare, legacy and with the confined shape spelled out', () => {
    for (const sandbox of [PUBLIC, { trust: 'internal' }, { ...CONFINED, trust: 'public' }]) {
      expect(isConfinedDsh({ sandbox })).toBe(true);
      expect(isPublicDsh({ sandbox })).toBe(true);
    }
    expect(isPublicDsh({ sandbox: CONFINED })).toBe(false);
    expect(isPublicDsh({})).toBe(false);
    for (const sandbox of [
      { trust: 'public', mode: 'none' },
      { trust: 'public', mode: 'workspace', network: { policy: 'unrestricted' } },
      { trust: 'public', mode: 'bwrap' },
    ]) {
      expect(() => isConfinedDsh({ sandbox })).toThrow(/one confined shape/);
    }
  });

  test('the turn runs in an empty folder the adapter owns, with every native tool plugin off', async () => {
    await withSeat(async ({ ctx, home, wraps }) => {
      await writeFile(join(ctx.cwd, '.env'), 'DSH_SEAT_PLANTED=1\n');
      await mkdir(turnDir(home), { recursive: true });
      await writeFile(join(turnDir(home), 'left-over'), 'from an earlier turn');
      const result = await dsh.spawn('[[reply:public-ok]]', publicSeat(ctx));
      expect(result.text).toBe('public-ok');
      const seen = readReport(home);
      expect(realpathSync(seen.cwd)).toBe(realpathSync(turnDir(home)));
      expect(existsSync(join(turnDir(home), 'left-over'))).toBe(false);
      expect(seen.sandboxPolicy).toEqual({ mode: 'danger-full-access', workspaceRoot: turnDir(home) });
      const disabled = seen.rows.filter((row) => row.disabled === true).map((row) => row.id);
      for (const id of DSH_PUBLIC_DISABLED_PLUGINS) expect(disabled).toContain(id);
      for (const id of ['tool-bash', 'tool-fs', 'tool-web', 'tool-workflow', 'tool-subagent', 'tool-skill', 'agent-instructions']) {
        expect(DSH_PUBLIC_DISABLED_PLUGINS).toContain(id);
      }
      const { options } = wraps.find((entry) => entry.inner);
      expect(options).toMatchObject({ workspacePath: turnDir(home), workspaceAccess: 'write', statePath: home });
      // The seat's workspace is no part of the jail.
      expect(buildSeatbeltProfile(options)).not.toContain(ctx.cwd);
    });
  });

  test('the Commonly MCP loads only behind the guard, which comes from the adapter', async () => {
    await withSeat(async ({ ctx, home }) => {
      await dsh.spawn('[[reply:ok]]', publicSeat(ctx));
      const { rows } = readReport(home);
      const inserts = rows.filter((row) => row.insert).map((row) => row.insert[0]);
      expect(inserts.map((entry) => entry.id)).toEqual(['commonly-public-guard', 'mcp-commonly']);
      const [guard, mcp] = inserts;
      expect(guard.name).toMatch(/commonly-public-guard\.mjs$/);
      expect(guard.name.startsWith(ctx.cwd)).toBe(false);
      expect(guard.config).toEqual({ withheld: [...PUBLIC_SEAT_WITHHELD_TOOLS] });
      expect(mcp.inject).toEqual([DSH_PUBLIC_GUARD_SERVICE]);
      expect(mcp.config.env.COMMONLY_MCP_PUBLIC_SEAT).toBe('1');
      // F468: the server is told what to keep off the list; the guard still refuses at the call.
      expect(mcp.config.env.COMMONLY_MCP_WITHHELD_TOOLS).toBe(PUBLIC_SEAT_WITHHELD_TOOLS.join(','));
      // The last row is the MCP, which the stub reads.
      expect(rows.at(-1).insert[0].id).toBe('mcp-commonly');
    });
  });

  test('an owner-woken turn gets the memory writes back and nothing else', async () => {
    await withSeat(async ({ ctx, home }) => {
      await dsh.spawn('[[reply:ok]]', publicSeat(ctx, { ownerWoken: true }));
      const guard = readReport(home).rows.find((row) => row.insert?.[0].id === 'commonly-public-guard').insert[0];
      expect(guard.config.withheld).toEqual(publicSeatWithheldTools({ ownerWoken: true }));
      expect(guard.config.withheld).toContain('commonly_attach_file');
      expect(guard.config.withheld).not.toContain('commonly_write_agent_memory');
      const { mcp } = readReport(home);
      expect(mcp.env.COMMONLY_MCP_WITHHELD_TOOLS).toBe(guard.config.withheld.join(','));
    });
  });

  test('a public turn reaches only the provider proxy and the relay', async () => {
    await withSeat(async ({ ctx, home, wraps }) => {
      await dsh.spawn('[[reply:ok]]', publicSeat(ctx));
      const seen = readReport(home);
      expect(seen.env.HTTPS_PROXY).toBeUndefined();
      expect(seen.egress).toBeNull();
      expect(seen.relay).toBe('instance-ok');
      const { options } = wraps.find((entry) => entry.inner);
      expect(options.loopbackNetworkPorts).toHaveLength(2);
      // CodeRabbit on #4021: the CLI makes this folder, so a link left by an earlier
      // turn's process is refused, never followed to a write grant on its target.
      expect(options.pinWorkspace).toBe(true);
      expect(options.loopbackNetworkPorts).toContain(Number(new URL(seen.mcp.env.COMMONLY_API_URL).port));
    });
  });

  test('a public home keeps only its sessions between turns, so nothing planted there loads', async () => {
    await withSeat(async ({ ctx, home }) => {
      const planted = [
        ['profiles', 'headless', 'cordis.patch.yml'], ['cordis.patch.yml'], ['.env'], ['planted.mjs'],
        ['.node_modules', 'x', 'index.js'],
      ];
      for (const parts of planted) {
        await mkdir(join(home, ...parts.slice(0, -1)), { recursive: true });
        await writeFile(join(home, ...parts), 'planted');
      }
      await mkdir(join(home, 'sessions', 'w'), { recursive: true });
      await writeFile(join(home, 'sessions', 'w', 'kept'), 'session');
      await dsh.spawn('[[reply:ok]]', publicSeat(ctx));
      for (const parts of planted) expect(existsSync(join(home, parts[0]))).toBe(false);
      expect(readFileSync(join(home, 'sessions', 'w', 'kept'), 'utf8')).toBe('session');
    });
  });

  test('a sessions symlink is removed, not kept, and the native-addon cache in tmp/ is cleared', async () => {
    await withSeat(async ({ ctx, root, home }) => {
      const elsewhere = join(root, 'elsewhere');
      await mkdir(elsewhere, { recursive: true });
      await writeFile(join(elsewhere, 'planted'), 'planted');
      await mkdir(join(home, 'tmp', 'cache'), { recursive: true });
      await writeFile(join(home, 'tmp', 'cache', 'addon.node'), 'planted');
      await symlink(elsewhere, join(home, 'sessions'));
      await dsh.spawn('[[reply:ok]]', publicSeat(ctx));
      expect(existsSync(join(home, 'sessions'))).toBe(false);
      expect(existsSync(join(home, 'tmp', 'cache'))).toBe(false);
      // The link went, its target stayed.
      expect(readFileSync(join(elsewhere, 'planted'), 'utf8')).toBe('planted');
    });
  });

  test('a public seat never shares a home with a private turn of the same agent', () => {
    const seat = { instanceUrl: 'https://api.example', agentName: 'deep' };
    const privateHome = seatHome({ ...seat, environment: { sandbox: CONFINED } });
    expect(seatHome({ ...seat, environment: {} })).toBe(privateHome);
    for (const sandbox of [PUBLIC, { trust: 'internal' }, { ...CONFINED, trust: 'public' }]) {
      expect(seatHome({ ...seat, environment: { sandbox } })).not.toBe(privateHome);
    }
    // A private seat keeps the home it had before F115, sessions included.
    const before = createHash('sha256').update(`${seat.instanceUrl}\0${seat.agentName}`).digest('hex').slice(0, 24);
    expect(privateHome).toBe(join(homedir(), '.commonly', 'dsh-homes', before));
  });

  test('the adapter names the MCP server\'s withheld-tools variable as the server does', async () => {
    const { WITHHELD_TOOLS_ENV } = await import('../../commonly-mcp/src/server.js');
    expect(WITHHELD_TOOLS_MCP_ENV).toBe(WITHHELD_TOOLS_ENV);
  });

  test('the guard refuses every tool but the Commonly ones it was not told to withhold', async () => {
    const { apply, inject, name } = await import('../src/lib/adapters/dsh-public-guard.mjs');
    expect(name).toBe('commonly-public-guard');
    expect(inject).toEqual(['tools']);
    let guard;
    const provided = {};
    const ctx = { tools: { guard: (fn) => { guard = fn; } }, provide: (key, value) => { provided[key] = value; } };
    apply(ctx, { withheld: ['commonly_attach_file'] });
    expect(Object.keys(provided)).toEqual([DSH_PUBLIC_GUARD_SERVICE]);
    expect(guard({ name: 'mcp__commonly__commonly_post_message' })).toBeUndefined();
    for (const tool of ['bash', 'write', 'web_fetch', 'run_code', 'subagent', 'mcp__commonly__commonly_attach_file',
      'mcp__commonly__', 'mcp__other__commonly_post_message', 'xmcp__commonly__commonly_post_message', '']) {
      expect(guard({ name: tool })).toMatch(/is not available on a public seat/);
    }
    expect(guard({})).toMatch(/is not available on a public seat/);
    expect(() => apply(ctx, {})).toThrow(/withheld/);
  });
});
