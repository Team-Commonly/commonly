/**
 * adapters.pi.grant-broker.test.mjs — F175c: a public pi seat on macOS carries
 * the grant broker; every other pi seat refuses it.
 *
 * A public pi turn is the only pi turn that is confined (Seatbelt, F113b), and
 * it runs with no built-in tool at all, so the model cannot open a file: its
 * only tools are the MCP tools the bridge registers, minus the withheld list
 * (commonly_attach_file, the one Commonly tool that reads a local path, among
 * them). On top of that the per-spawn credential file goes away once pi has
 * loaded its extensions, twice over: the bridge deletes it inside pi before its
 * factory returns, which pi awaits before it creates the session, and the
 * parent deletes it again at pi's first JSON line (print-mode.js, 0.84.1).
 *
 * The real `pi` binary is never invoked: `_spawnImpl` replaces the spawn, and a
 * fake package stands in for pi's install tree.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import {
  mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from 'fs/promises';
import { Writable } from 'stream';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pi, { TESTED_PI_VERSIONS, resolveMcpServers } from '../src/lib/adapters/pi.js';
import {
  GRANT_BROKER_PUBLIC_ONLY_REFUSAL, readServers, removeSpawnCredential,
} from '../src/lib/adapters/pi-mcp-client.mjs';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'adapters');

const line = (obj) => `${JSON.stringify(obj)}\n`;
const HEADER = line({ type: 'session', version: 3, id: 'sess-1', cwd: '/w' });
const assistant = (text) => line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const BROKER = {
  name: 'commonly-grant-broker',
  transport: 'http',
  url: '${COMMONLY_API_URL}/api/mcp/grants/g1',
  headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
};
const KERNEL = {
  name: 'commonly',
  transport: 'stdio',
  command: ['node', '/opt/mcp/server.js'],
  // The launcher channel: the bridge reads the file this names at load.
  env: { COMMONLY_TOKEN_FILE: '${COMMONLY_TOKEN_FILE}' },
};

/**
 * A child whose stdout is a list of steps: a string is written, a function is
 * called (to look at the disk between two lines). The credential file's path
 * is read off the fd 3 payload, which is what the bridge would read.
 */
const scriptedChild = (steps, { code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.fd3Payload = '';
  proc.killedWith = null;
  const fd3 = new Writable({ write(chunk, _enc, done) { proc.fd3Payload += chunk.toString(); done(); } });
  fd3.on('error', () => {});
  proc.stdio = [null, proc.stdout, proc.stderr, fd3];
  proc.kill = (signal) => { proc.killedWith = signal || 'SIGTERM'; };
  const run = async () => {
    for (const step of steps) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (proc.killedWith) break;
      if (typeof step === 'function') step(proc);
      else proc.stdout.emit('data', Buffer.from(step));
    }
    proc.emit('close', proc.killedWith ? null : code);
  };
  setTimeout(run, 1);
  return proc;
};

const credentialPathOf = (proc) => {
  const servers = JSON.parse(proc.fd3Payload || '[]');
  return servers.find((s) => s.env?.COMMONLY_TOKEN_FILE)?.env.COMMONLY_TOKEN_FILE || null;
};

let root;
let home;
let workspace;
let binDir;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-grant-')));
  home = join(root, 'pi-home');
  workspace = join(root, 'workspace');
  const packageRoot = join(root, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  binDir = join(root, 'bin');
  await Promise.all([mkdir(join(packageRoot, 'dist'), { recursive: true }), mkdir(binDir), mkdir(workspace)]);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
  await writeFile(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink(join(packageRoot, 'dist', 'cli.js'), join(binDir, 'pi'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const wrapCapture = () => (inner) => ['/usr/bin/sandbox-exec', '-p', '(version 1)(deny default)', ...inner];

const publicCtx = (over = {}) => ({
  cwd: workspace,
  agentName: 'kai-public',
  runtimeToken: 'cm_agent_secret',
  instanceUrl: 'https://api.example',
  env: { PATH: `${binDir}:/usr/bin`, COMMONLY_LITELLM_KEY: 'sk-real-provider-key' },
  environment: { model: 'deepseek-v4-flash', sandbox: { trust: 'public' }, mcp: [KERNEL, BROKER] },
  _piHome: home,
  _platform: 'darwin',
  _version: TESTED_PI_VERSIONS[0],
  _bridgePath: join(ADAPTERS_DIR, 'pi-commonly-mcp.mjs'),
  _wrapArgvWithSeatbelt: wrapCapture(),
  _startProviderProxy: async () => ({ baseURL: 'http://127.0.0.1:4999/v1', port: 4999, token: 'proxy-token', close: async () => {} }),
  ...over,
});

const spawnWith = (steps, over = {}, childOpts = {}) => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    const proc = scriptedChild(typeof steps === 'function' ? steps(calls) : steps, childOpts);
    calls.push({ cmd, args, opts, proc });
    return proc;
  };
  return { calls, run: () => pi.spawn('hi', publicCtx({ _spawnImpl: impl, ...over })) };
};

describe('a public pi seat on macOS carries the grant broker', () => {
  test('the broker reaches the bridge on fd 3, bearer filled, marked confined, withheld tools named', async () => {
    const { calls, run } = spawnWith([HEADER, assistant('ok')]);
    await run();
    const servers = JSON.parse(calls[0].proc.fd3Payload);
    const broker = servers.find((s) => s.name === 'commonly-grant-broker');
    expect(broker).toEqual(expect.objectContaining({
      url: 'https://api.example/api/mcp/grants/g1',
      headers: { Authorization: 'Bearer cm_agent_secret' },
      confined: true,
    }));
    expect(broker.withheldTools).toContain('commonly_attach_file');
    // The bearer rides the pipe only: not argv, not the jailed environment.
    expect(JSON.stringify(calls[0].args)).not.toContain('cm_agent_secret');
    expect(JSON.stringify(calls[0].opts.env)).not.toContain('cm_agent_secret');
  });

  test('the turn the broker rides has no tool that can open a file', async () => {
    const { calls, run } = spawnWith([HEADER, assistant('ok')]);
    await run();
    const inner = calls[0].args.slice(2);
    expect(calls[0].cmd).toBe('/usr/bin/sandbox-exec');
    expect(inner).toContain('--no-builtin-tools');
    const excluded = inner[inner.indexOf('--exclude-tools') + 1].split(',');
    for (const tool of ['read', 'bash', 'grep', 'find', 'ls', 'commonly_attach_file']) expect(excluded).toContain(tool);
    expect(inner.some((arg) => /pi-shell-env\.mjs$/.test(arg))).toBe(false);
  });

  test('the bridge keeps a confined broker entry, and drops one with no mark', () => {
    const entry = { name: 'commonly-grant-broker', url: 'https://api.example/api/mcp/grants/g1', headers: {} };
    expect(readServers(JSON.stringify([{ ...entry, confined: true }]))).toHaveLength(1);
    expect(readServers(JSON.stringify([entry]))).toEqual([]);
    expect(readServers(JSON.stringify([{ ...entry, confined: 'yes' }]))).toEqual([]);
  });
});

describe('the credential file lives only until pi has loaded its extensions', () => {
  test('present when pi starts, gone at the first JSON line, before any model output', async () => {
    const seen = {};
    const { run } = spawnWith(() => [
      (proc) => { seen.path = credentialPathOf(proc); seen.atStart = existsSync(seen.path); },
      HEADER,
      () => { seen.afterHeader = existsSync(seen.path); },
      assistant('ok'),
    ]);
    const out = await run();
    expect(out.text).toBe('ok');
    expect(seen.path).toMatch(/credentials/);
    expect(seen.atStart).toBe(true);
    expect(seen.afterHeader).toBe(false);
  });

  test('a header split across two chunks still counts once whole', async () => {
    const seen = {};
    const half = HEADER.length >> 1;
    const { run } = spawnWith(() => [
      (proc) => { seen.path = credentialPathOf(proc); },
      HEADER.slice(0, half),
      () => { seen.afterHalf = existsSync(seen.path); },
      HEADER.slice(half),
      () => { seen.afterWhole = existsSync(seen.path); },
      assistant('ok'),
    ]);
    await run();
    expect(seen.afterHalf).toBe(true);
    expect(seen.afterWhole).toBe(false);
  });

  test('a delete that fails ends the turn and kills pi', async () => {
    const { calls, run } = spawnWith([HEADER, assistant('should not be returned')], {
      _rmSync: () => { throw new Error('EPERM'); },
    });
    await expect(run()).rejects.toThrow(/could not delete its connector credential/);
    expect(calls[0].proc.killedWith).toBe('SIGKILL');
  });

  test('a public turn with no broker keeps the old lifetime: removed when the turn ends', async () => {
    const seen = {};
    const { run } = spawnWith(() => [
      (proc) => { seen.path = credentialPathOf(proc); },
      HEADER,
      () => { seen.afterHeader = existsSync(seen.path); },
      assistant('ok'),
    ], { environment: { model: 'deepseek-v4-flash', sandbox: { trust: 'public' }, mcp: [KERNEL] } });
    await run();
    expect(seen.afterHeader).toBe(true);
    expect(existsSync(seen.path)).toBe(false);
  });
});

describe('the bridge deletes the credential inside pi, before the session exists', () => {
  const BROKER_URL = 'https://api.example/api/mcp/grants/g1';
  const entry = (over = {}) => ({ name: 'broker', url: BROKER_URL, confined: true, credentialDir: '/seat/credentials/a-1', ...over });
  const seam = (over = {}) => {
    const out = { rm: [], lines: [], exits: [] };
    out.opts = {
      rm: (dir, opts) => { out.rm.push([dir, opts]); },
      write: (line) => out.lines.push(line),
      exit: (code) => out.exits.push(code),
      ...over,
    };
    return out;
  };

  test('the adapter names the directory on the broker entry, as a path, on a grant turn only', async () => {
    const seen = {};
    const { calls, run } = spawnWith(() => [
      (proc) => { seen.path = credentialPathOf(proc); },
      HEADER,
      assistant('ok'),
    ]);
    await run();
    const servers = JSON.parse(calls[0].proc.fd3Payload);
    const broker = servers.find((s) => s.name === 'commonly-grant-broker');
    expect(broker.credentialDir).toBe(dirname(seen.path));
    expect(servers.find((s) => s.name === 'commonly').credentialDir).toBeUndefined();
    expect(JSON.stringify(broker.credentialDir)).not.toContain('cm_agent_secret');
    // Not ambient: a private turn passes the launcher's environment through,
    // and an inherited variable must never be able to name a directory to delete.
    expect(JSON.stringify(calls[0].opts.env)).not.toContain(broker.credentialDir.split('/').pop() + '"');

    const quiet = spawnWith([HEADER, assistant('ok')], {
      environment: { model: 'deepseek-v4-flash', sandbox: { trust: 'public' }, mcp: [KERNEL] },
    });
    await quiet.run();
    expect(quiet.calls[0].proc.fd3Payload).not.toContain('credentialDir');
  });

  test('a data server on the same turn is not told the directory', async () => {
    const data = { name: 'docs', transport: 'http', url: 'https://api.example/mcp', headers: {} };
    const { calls, run } = spawnWith([HEADER, assistant('ok')], {
      environment: { model: 'deepseek-v4-flash', sandbox: { trust: 'public' }, mcp: [KERNEL, data, BROKER] },
    });
    await run();
    const servers = JSON.parse(calls[0].proc.fd3Payload);
    expect(servers.find((s) => s.name === 'docs')).toBeDefined();
    expect(servers.find((s) => s.name === 'docs').credentialDir).toBeUndefined();
    expect(servers.find((s) => s.name === 'commonly-grant-broker').credentialDir).toEqual(expect.any(String));
  });

  test('readServers carries the field through to the helper', () => {
    expect(readServers(JSON.stringify([entry()]))[0].credentialDir).toBe('/seat/credentials/a-1');
  });

  test('removes the named directory once, however many grants share it', () => {
    const s = seam();
    expect(removeSpawnCredential([entry(), entry({ name: 'broker-2' })], s.opts)).toBe(true);
    expect(s.rm).toEqual([['/seat/credentials/a-1', { recursive: true, force: true }]]);
    expect(s.exits).toEqual([]);
  });

  test('removes nothing when no entry names a directory', () => {
    const s = seam();
    expect(removeSpawnCredential([{ name: 'commonly', command: ['node'] }], s.opts)).toBe(true);
    expect(s.rm).toEqual([]);
    expect(s.exits).toEqual([]);
  });

  test.each([
    ['an unconfined entry', { confined: undefined }],
    ['an entry off the broker path', { url: 'https://api.example/mcp' }],
    ['a stdio entry', { url: undefined, command: ['node'] }],
  ])('%s names no directory to delete', (_label, over) => {
    const s = seam();
    expect(removeSpawnCredential([entry(over)], s.opts)).toBe(true);
    expect(s.rm).toEqual([]);
  });

  test('a delete that fails stops pi with a clear line, naming no secret', () => {
    const s = seam({ rm: () => { throw new Error('EPERM: operation not permitted'); } });
    expect(removeSpawnCredential([entry()], s.opts)).toBe(false);
    expect(s.exits).toEqual([1]);
    expect(s.lines.join('')).toMatch(/could not delete .*\/seat\/credentials\/a-1.*EPERM/);
    expect(s.lines.join('')).toMatch(/\n$/);
  });

  test('a relative path is a failed delete, not a delete in the working directory', () => {
    const s = seam();
    expect(removeSpawnCredential([entry({ credentialDir: 'credentials/a-1' })], s.opts)).toBe(false);
    expect(s.rm).toEqual([]);
    expect(s.exits).toEqual([1]);
  });

  test('with no seams, a failed delete really ends the process non-zero, before anything else runs', () => {
    const helper = fileURLToPath(new URL('../src/lib/adapters/pi-mcp-client.mjs', import.meta.url));
    const script = `import(${JSON.stringify(helper)}).then(({ removeSpawnCredential }) => {
      removeSpawnCredential(${JSON.stringify([entry({ credentialDir: 'credentials/a-1' })])});
      process.stdout.write('prompt ran');
    });`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^\[commonly-pi-bridge\] could not delete/m);
  });

  test('the parent tolerates the file already gone, and still runs the turn', async () => {
    const seen = {};
    const { run } = spawnWith(() => [
      (proc) => { seen.path = credentialPathOf(proc); rmSync(dirname(seen.path), { recursive: true, force: true }); },
      HEADER,
      assistant('ok'),
    ]);
    expect((await run()).text).toBe('ok');
    expect(existsSync(seen.path)).toBe(false);
  });

  test('a bridge that stopped pi surfaces as the turn\'s error', async () => {
    const { run } = spawnWith([
      (proc) => { proc.stderr.emit('data', Buffer.from('[commonly-pi-bridge] could not delete the credential\n')); },
    ], {}, { code: 1 });
    await expect(run()).rejects.toThrow(/pi exited 1: .*could not delete the credential/);
  });
});

describe('every other pi seat refuses the broker', () => {
  const quiet = () => jest.spyOn(console, 'warn').mockImplementation(() => {});

  test('a private pi seat, even when the server flagged the broker as named (F94)', async () => {
    const warn = quiet();
    try {
      for (const broker of [BROKER, { ...BROKER, byoNamed: true }]) {
        const { calls, run } = spawnWith([assistant('ok')], {
          environment: { model: 'deepseek-v4-flash', mcp: [KERNEL, broker] },
        });
        // eslint-disable-next-line no-await-in-loop
        await run();
        const servers = JSON.parse(calls[0].proc.fd3Payload);
        expect(servers.map((s) => s.name)).toEqual(['commonly']);
      }
      expect(warn.mock.calls.filter(([msg]) => msg.includes(GRANT_BROKER_PUBLIC_ONLY_REFUSAL))).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('resolveMcpServers drops the broker unless the turn is public', () => {
    const warn = quiet();
    try {
      const ctx = { runtimeToken: 't', instanceUrl: 'https://api.example' };
      expect(resolveMcpServers([BROKER], ctx)).toEqual([]);
      expect(resolveMcpServers([BROKER], { ...ctx, publicSeat: true })).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('a public pi seat off macOS does not start at all', async () => {
    const { calls, run } = spawnWith([HEADER, assistant('ok')], { _platform: 'linux' });
    await expect(run()).rejects.toThrow(/macOS Seatbelt/);
    expect(calls).toHaveLength(0);
  });
});
