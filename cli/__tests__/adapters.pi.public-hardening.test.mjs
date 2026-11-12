/**
 * adapters.pi.public-hardening.test.mjs — F146, from the #3447 reviews.
 *
 * A public pi turn:
 *   - passes --no-context-files: pi 0.84.1 discovers AGENTS.md / CLAUDE.md
 *     independently of `--no-approve` (resource-loader.js gates them on
 *     `noContextFiles` alone);
 *   - never puts the provider key on pi's argv or in the fd 3 server list;
 *   - deletes the per-spawn credential file at pi's first JSON line, after the
 *     bridge has read it, whether or not the turn carries a grant broker;
 *   - closes the provider proxy and removes the credential file on every
 *     ending: a clean reply, a non-zero exit, a spawn error and a timeout.
 *
 * The real `pi` binary is never invoked: `_spawnImpl` replaces the spawn, and a
 * fake package stands in for pi's install tree.
 */
import { EventEmitter } from 'events';
import { existsSync, readdirSync } from 'fs';
import {
  mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from 'fs/promises';
import { Writable } from 'stream';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pi, { TESTED_PI_VERSIONS, buildArgs } from '../src/lib/adapters/pi.js';

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'adapters');

const line = (obj) => `${JSON.stringify(obj)}\n`;
const HEADER = line({ type: 'session', version: 3, id: 'sess-1', cwd: '/w' });
const assistant = (text) => line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const PROVIDER_KEY = 'sk-real-provider-key';

const KERNEL = {
  name: 'commonly',
  transport: 'stdio',
  command: ['node', '/opt/mcp/server.js'],
  env: { COMMONLY_TOKEN_FILE: '${COMMONLY_TOKEN_FILE}' },
};

// A child whose stdout is a list of steps: a string is written, a function is
// called. `hang` keeps it open until it is killed.
const scriptedChild = (steps, { code = 0, hang = false, spawnError = null } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.fd3Payload = '';
  proc.killedWith = null;
  const fd3 = new Writable({ write(chunk, _enc, done) { proc.fd3Payload += chunk.toString(); done(); } });
  fd3.on('error', () => {});
  proc.stdio = [null, proc.stdout, proc.stderr, fd3];
  proc.kill = (signal) => {
    proc.killedWith = signal || 'SIGTERM';
    if (hang) setTimeout(() => proc.emit('close', null, proc.killedWith), 1);
  };
  const run = async () => {
    if (spawnError) { proc.emit('error', spawnError); return; }
    for (const step of steps) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (proc.killedWith) break;
      if (typeof step === 'function') step(proc);
      else proc.stdout.emit('data', Buffer.from(step));
    }
    if (!hang) proc.emit('close', proc.killedWith ? null : code);
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
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-f146-')));
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

const run = (steps, { childOpts = {}, ...over } = {}) => {
  const calls = [];
  const proxy = { closed: 0 };
  const impl = (cmd, args, opts) => {
    const proc = scriptedChild(typeof steps === 'function' ? steps(calls) : steps, childOpts);
    calls.push({ cmd, args, opts, proc });
    return proc;
  };
  const ctx = {
    cwd: workspace,
    agentName: 'kai-public',
    runtimeToken: 'cm_agent_secret',
    instanceUrl: 'https://api.example',
    env: { PATH: `${binDir}:/usr/bin`, COMMONLY_LITELLM_KEY: PROVIDER_KEY },
    environment: { model: 'deepseek-v4-flash', sandbox: { trust: 'public' }, mcp: [KERNEL] },
    _piHome: home,
    _platform: 'darwin',
    _version: TESTED_PI_VERSIONS[0],
    _bridgePath: join(ADAPTERS_DIR, 'pi-commonly-mcp.mjs'),
    _wrapArgvWithSeatbelt: (inner) => ['/usr/bin/sandbox-exec', '-p', '(version 1)(deny default)', ...inner],
    _startProviderProxy: async () => ({
      baseURL: 'http://127.0.0.1:4999/v1',
      port: 4999,
      token: 'proxy-token',
      close: async () => { proxy.closed += 1; },
    }),
    _spawnImpl: impl,
    ...over,
  };
  return { calls, proxy, result: pi.spawn('hi', ctx) };
};

// The public seat home is `<_piHome>-public` (seatHome).
const credentialsDir = () => join(`${home}-public`, 'credentials');

describe('a public pi turn loads no context files', () => {
  const base = {
    prompt: 'hi', provider: 'litellm', model: 'm', sessionId: 's', isResume: false, sessionDir: '/s', bridge: null,
  };

  test('buildArgs passes --no-context-files on a public turn only', () => {
    expect(buildArgs({ ...base, publicSeat: true })).toContain('--no-context-files');
    expect(buildArgs({ ...base, publicSeat: false })).not.toContain('--no-context-files');
  });

  test('the jailed pi gets it, before the prompt', async () => {
    const { calls, result } = run([HEADER, assistant('ok')]);
    await result;
    const inner = calls[0].args.slice(2);
    expect(inner).toContain('--no-context-files');
    expect(inner.indexOf('--no-context-files')).toBeLessThan(inner.length - 1);
  });
});

describe('a public pi turn starts with no system prompt file in its agent folder', () => {
  // pi 0.84.1 loads SYSTEM.md and APPEND_SYSTEM.md from PI_CODING_AGENT_DIR with
  // no flag to turn that off; the CLI writes only models.json there.
  test.each(['SYSTEM.md', 'APPEND_SYSTEM.md'])('%s left in the folder is removed before pi starts', async (file) => {
    const agentDir = join(`${home}-public`, 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, file), 'left over');
    const seen = {};
    const { result } = run([() => { seen.present = existsSync(join(agentDir, file)); }, HEADER, assistant('ok')]);
    await result;
    expect(seen.present).toBe(false);
  });
});

describe('the provider key never reaches pi\'s argv or the fd 3 list', () => {
  test('neither carries it, and the jailed env holds only the proxy token', async () => {
    const { calls, result } = run([HEADER, assistant('ok')]);
    await result;
    const [call] = calls;
    expect([call.cmd, ...call.args].join('\n')).not.toContain(PROVIDER_KEY);
    expect(call.proc.fd3Payload).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(call.opts.env)).not.toContain(PROVIDER_KEY);
    expect(call.opts.env.COMMONLY_LITELLM_KEY).toBe('proxy-token');
  });
});

describe('the credential file goes at pi\'s first JSON line on every public turn', () => {
  test('a turn with no grant broker: present when pi starts, gone after the header', async () => {
    const seen = {};
    const { result } = run(() => [
      (proc) => { seen.path = credentialPathOf(proc); seen.atStart = existsSync(seen.path); },
      HEADER,
      () => { seen.afterHeader = existsSync(seen.path); },
      assistant('ok'),
    ]);
    expect((await result).text).toBe('ok');
    expect(seen.path).toMatch(/credentials/);
    expect(seen.atStart).toBe(true);
    expect(seen.afterHeader).toBe(false);
  });

  test('a delete that fails ends the turn and kills pi', async () => {
    const { calls, result } = run([HEADER, assistant('should not be returned')], {
      _rmSync: () => { throw new Error('EPERM'); },
    });
    await expect(result).rejects.toThrow(/could not delete its runtime credential/);
    expect(calls[0].proc.killedWith).toBe('SIGKILL');
  });
});

describe('the proxy closes and the credential file goes on every ending', () => {
  const ended = (proxy, path) => {
    expect(proxy.closed).toBe(1);
    expect(path).toMatch(/credentials/);
    expect(existsSync(path)).toBe(false);
  };

  test('a clean reply', async () => {
    const seen = {};
    const { proxy, result } = run(() => [(proc) => { seen.path = credentialPathOf(proc); }, HEADER, assistant('ok')]);
    await result;
    ended(proxy, seen.path);
  });

  test('a non-zero exit before any line (the bridge never ran)', async () => {
    const seen = {};
    const { proxy, result } = run(() => [(proc) => { seen.path = credentialPathOf(proc); }], { childOpts: { code: 1 } });
    await expect(result).rejects.toThrow(/pi exited 1/);
    ended(proxy, seen.path);
  });

  test('a spawn error', async () => {
    const { proxy, result } = run([], { childOpts: { spawnError: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) } });
    await expect(result).rejects.toThrow(/EACCES/);
    expect(proxy.closed).toBe(1);
    // The directory itself is made before the spawn; what matters is that no
    // credential is left in it.
    expect(existsSync(credentialsDir())).toBe(true);
    expect(readdirSync(credentialsDir())).toEqual([]);
  });

  test('a timeout', async () => {
    const seen = {};
    const { proxy, result } = run(() => [(proc) => { seen.path = credentialPathOf(proc); }], {
      timeoutMs: 40,
      childOpts: { hang: true },
    });
    await expect(result).rejects.toThrow(/timed out/);
    ended(proxy, seen.path);
  });
});
