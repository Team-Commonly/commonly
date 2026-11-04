/**
 * adapters.claude.seatbelt-api-key.test.mjs — F151
 *
 * A confined Claude seat on macOS (Seatbelt: sandbox.mode workspace or
 * read-only, trust public or workspace) strips its environment to the safe
 * list and, without a key, signs in only through the OS user's keychain. A seat
 * whose environment carries ANTHROPIC_API_KEY used to start with neither and
 * exit "Not logged in". It now reaches the model the way a bwrap seat does:
 * through a per-turn loopback provider proxy that holds the key on the host.
 * The jailed claude gets the proxy's address and token, never the key, and no
 * keychain access.
 *
 * Uses ctx._spawnImpl and ctx._startProviderProxy, so no real claude,
 * sandbox-exec or network runs.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import fs from 'fs';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;
const { spawnSync } = await import('child_process');

const HOST_KEY = 'sk-ant-host-only-f151';
const PROXY_PORT = 41551;
const PROXY_TOKEN = 'per-turn-proxy-token-f151';
const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');

const fakeChild = ({ stdout = '', code = 0 } = {}) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', code);
  }, 0);
  return proc;
};

const COMMONLY_CONNECTED = [
  { type: 'system', subtype: 'init', mcp_servers: [{ name: 'commonly', status: 'connected' }] },
  { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
].map((event) => JSON.stringify(event)).join('\n');

describe('a Seatbelt-confined Claude seat with ANTHROPIC_API_KEY (F151)', () => {
  const originalPlatform = process.platform;
  let cwd;
  let state;
  let scratch;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f151-cwd-'));
    state = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f151-state-'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f151-scratch-'));
    fs.writeFileSync(path.join(scratch, 'server.mjs'), '');
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: '/usr/bin/true\n' }
      : { status: 0, stdout: '' }));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    for (const dir of [cwd, state, scratch]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const proxyStub = () => {
    const started = [];
    const closed = [];
    return {
      started,
      closed,
      start: async (opts) => {
        started.push(opts);
        return {
          baseURL: `http://127.0.0.1:${PROXY_PORT}/`,
          token: PROXY_TOKEN,
          port: PROXY_PORT,
          close: async () => { closed.push(true); },
        };
      },
    };
  };

  const spawnImpl = ({ code = 0, stdout = COMMONLY_CONNECTED } = {}) => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts, keychainLink: fs.existsSync(path.join(state, 'Library', 'Keychains')) });
      return fakeChild({ stdout, code });
    };
    return { impl, calls };
  };

  const seatbeltSpawn = (impl, { trust = 'public', mode = 'workspace', env = {}, extra = {} } = {}) => claude.spawn('hi', {
    agentName: 'f151-seat',
    sessionId: null,
    cwd,
    skillMountDir: scratch,
    env: { PATH: process.env.PATH, USER: 'safe-user', ...env },
    environment: {
      model: 'test-model',
      sandbox: { mode, trust },
      mcp: [{ name: 'commonly', transport: 'stdio', command: [process.execPath, path.join(scratch, 'server.mjs')] }],
    },
    _publicClaudeState: state,
    _spawnImpl: impl,
    ...extra,
  });

  describe.each([
    ['public', 'workspace'],
    ['public', 'read-only'],
    ['workspace', 'workspace'],
    ['workspace', 'read-only'],
  ])('trust %s, sandbox.mode %s', (trust, mode) => {
    test('starts the proxy with the host key and hands claude only its address and token', async () => {
      const proxy = proxyStub();
      const { impl, calls } = spawnImpl();
      await seatbeltSpawn(impl, {
        trust,
        mode,
        env: { ANTHROPIC_API_KEY: HOST_KEY, ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' },
        extra: { _startProviderProxy: proxy.start },
      });

      expect(proxy.started).toHaveLength(1);
      expect(proxy.started[0]).toEqual(expect.objectContaining({
        keyMaterial: HOST_KEY,
        wire: 'anthropic-messages',
        provider: { baseURL: 'https://gateway.example/anthropic' },
      }));
      expect(calls).toHaveLength(1);
      const { cmd, args, opts } = calls[0];
      expect(cmd).toBe('/usr/bin/sandbox-exec');
      expect(opts.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${PROXY_PORT}/`);
      expect(opts.env.ANTHROPIC_API_KEY).toBe(PROXY_TOKEN);
      // The real key is nowhere the jail can see: not env, not argv, not the profile.
      expect(JSON.stringify(opts.env)).not.toContain(HOST_KEY);
      expect(args.join('\n')).not.toContain(HOST_KEY);
    });

    test('the profile admits loopback to the proxy port and no keychain', async () => {
      const proxy = proxyStub();
      const { impl, calls } = spawnImpl();
      await seatbeltSpawn(impl, {
        trust, mode, env: { ANTHROPIC_API_KEY: HOST_KEY }, extra: { _startProviderProxy: proxy.start },
      });
      const profile = calls[0].args[1];
      expect(profile).toContain(`(allow network-outbound (remote tcp "localhost:${PROXY_PORT}"))`);
      // A key seat has no use for the person's keychain: neither the profile
      // rule nor the HOME link that points security(1) at it.
      expect(profile).not.toContain(LOGIN_KEYCHAIN);
      expect(calls[0].keychainLink).toBe(false);
    });

    test('the proxy is closed after the run, and after a failed one', async () => {
      const ok = proxyStub();
      await seatbeltSpawn(spawnImpl().impl, {
        trust, mode, env: { ANTHROPIC_API_KEY: HOST_KEY }, extra: { _startProviderProxy: ok.start },
      });
      expect(ok.closed).toHaveLength(1);

      const failed = proxyStub();
      await expect(seatbeltSpawn(spawnImpl({ code: 1, stdout: 'boom' }).impl, {
        trust, mode, env: { ANTHROPIC_API_KEY: HOST_KEY }, extra: { _startProviderProxy: failed.start },
      })).rejects.toThrow();
      expect(failed.closed).toHaveLength(1);
    });

    test('without a key the keychain login path is unchanged: no proxy, keychain admitted', async () => {
      const proxy = proxyStub();
      const { impl, calls } = spawnImpl();
      await seatbeltSpawn(impl, { trust, mode, extra: { _startProviderProxy: proxy.start } });
      expect(proxy.started).toHaveLength(0);
      const { args, opts } = calls[0];
      expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(opts.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(args[1]).toContain(`(literal "${LOGIN_KEYCHAIN}")`);
      expect(args[1]).not.toContain('(remote tcp "localhost:');
      expect(calls[0].keychainLink).toBe(true);
    });
  });

  test('the proxy defaults to Anthropic\'s API when the host names no base URL', async () => {
    const proxy = proxyStub();
    await seatbeltSpawn(spawnImpl().impl, { env: { ANTHROPIC_API_KEY: HOST_KEY }, extra: { _startProviderProxy: proxy.start } });
    expect(proxy.started[0].provider).toEqual({ baseURL: 'https://api.anthropic.com' });
  });

  test('a fresh-session retry keeps the proxy route and its loopback rule', async () => {
    const proxy = proxyStub();
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return calls.length === 1
        ? fakeChild({ stdout: 'Error: No conversation found with session ID', code: 1 })
        : fakeChild({ stdout: COMMONLY_CONNECTED });
    };
    await seatbeltSpawn(impl, {
      env: { ANTHROPIC_API_KEY: HOST_KEY },
      extra: { sessionId: '11111111-1111-4111-8111-111111111111', _startProviderProxy: proxy.start },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].opts.env.ANTHROPIC_API_KEY).toBe(PROXY_TOKEN);
    expect(calls[1].args[1]).toContain(`(remote tcp "localhost:${PROXY_PORT}")`);
    expect(proxy.started).toHaveLength(1);
    expect(proxy.closed).toHaveLength(1);
  });
});
