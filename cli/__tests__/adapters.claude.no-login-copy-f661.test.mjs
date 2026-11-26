/**
 * adapters.claude.no-login-copy-f661.test.mjs — F661
 *
 * Commonly keeps no copy of a person's Claude login. Anthropic's terms let a
 * person sign the unmodified `claude` binary in with their own subscription and
 * forbid a developer to collect, store or intermediate Claude.ai credentials.
 * Up to F661 a Linux (bwrap) seat got an access-only copy of
 * ~/.claude/.credentials.json in its state folder. Now:
 *   - a workspace seat signs in with the person's own CLAUDE_CODE_OAUTH_TOKEN
 *     (`claude setup-token`), passed through the jail's environment, never a file;
 *   - a public seat (strangers drive it) reaches the model only on an API key
 *     behind the per-turn proxy, never on the person's subscription;
 *   - a copy an older CLI left at our exact paths is removed, nothing else.
 *
 * Every login file here is a fake fixture. Uses the adapter's test seams, so no
 * real claude, bwrap or network runs.
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

const claudeModule = await import('../src/lib/adapters/claude.js');
const claude = claudeModule.default;
const { spawnSync } = await import('child_process');

const FAKE_LOGIN = '{"claudeAiOauth":{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":9999999999999}}\n';
const OWN_TOKEN = 'fixture-own-setup-token';

const fakeChild = ({ stdout = 'ok', code = 0 } = {}) => {
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

// Every regular file under `dir`, relative, links listed as links.
const filesUnder = (dir) => {
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};

describe('a Linux Claude seat keeps no copy of the person\'s login (F661)', () => {
  const originalPlatform = process.platform;
  let root;
  let cwd;
  let state;
  let operatorClaude;
  let install;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f661-'));
    cwd = path.join(root, 'project');
    state = path.join(root, 'homes', 'seat');
    operatorClaude = path.join(root, 'operator-claude');
    install = path.join(root, 'install');
    for (const dir of [cwd, state, operatorClaude, install]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(install, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(operatorClaude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: `${path.join(install, 'claude')}\n` } : undefined));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const recorder = () => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts, stateFiles: filesUnder(state) });
      return fakeChild();
    };
    return { calls, impl };
  };

  const spawnSeat = (impl, { trust = 'workspace', env = {}, extra = {} } = {}) => claude.spawn('hi', {
    agentName: 'f661-seat',
    sessionId: null,
    cwd,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude, ...env },
    environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust } },
    memoryLongTerm: '',
    _publicClaudeState: state,
    _detectBwrap: () => ({ available: true, path: 'bwrap' }),
    _startProviderProxy: async () => ({ baseURL: 'http://127.0.0.1:41661/', token: 'per-turn-f661', close: async () => {} }),
    _spawnImpl: impl,
    ...extra,
  });

  test('a workspace seat writes no login file, and gets the person\'s own token through its environment', async () => {
    const { calls, impl } = recorder();
    await spawnSeat(impl, { env: { CLAUDE_CODE_OAUTH_TOKEN: OWN_TOKEN } });
    expect(calls).toHaveLength(1);
    const { args, opts, stateFiles } = calls[0];
    // Nothing under the seat's state holds a login, during the turn or after.
    expect(stateFiles.filter((f) => /credentials/.test(f))).toEqual([]);
    expect(filesUnder(state).filter((f) => /credentials/.test(f))).toEqual([]);
    // The token reaches claude through the child's environment, not bwrap's argv.
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OWN_TOKEN);
    expect(args).not.toContain(OWN_TOKEN);
    // The person's login file is never rewritten.
    expect(fs.readFileSync(path.join(operatorClaude, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
    expect(JSON.stringify(opts.env)).not.toContain('fixture-access');
    expect(JSON.stringify(opts.env)).not.toContain('fixture-refresh');
  });

  test('a workspace seat with neither its own token nor a key is refused before anything is prepared or spawned', async () => {
    const { calls, impl } = recorder();
    const error = await spawnSeat(impl).catch((err) => err);
    expect(error.message).toMatch(/claude setup-token.*CLAUDE_CODE_OAUTH_TOKEN.*or set ANTHROPIC_API_KEY/s);
    expect(error.message).not.toMatch(/daemon/);
    expect(calls).toHaveLength(0);
    expect(filesUnder(state)).toEqual([]);
  });

  // The daemon's service carries neither the token nor ANTHROPIC_API_KEY, and
  // Commonly writes neither into it, so a daemon seat is sent to `agent run`.
  test('a daemon seat with neither is told the daemon carries neither, and to run it from a shell', async () => {
    const { calls, impl } = recorder();
    const error = await spawnSeat(impl, { env: { COMMONLY_MANAGED_RUNNER: '1' } }).catch((err) => err);
    expect(error.message).toMatch(/runs under the background daemon, which carries neither/);
    expect(error.message).toMatch(/never writes your token or key into its service file/);
    expect(error.message).toMatch(/agent run f661-seat` from a shell where you have exported CLAUDE_CODE_OAUTH_TOKEN.*or ANTHROPIC_API_KEY/s);
    expect(error.message).not.toMatch(/set CLAUDE_CODE_OAUTH_TOKEN to it in the agent's environment/);
    expect(calls).toHaveLength(0);
  });

  test('a workspace seat with only an API key runs on it through the per-turn proxy, with no login and no key in the jail', async () => {
    const { calls, impl } = recorder();
    await spawnSeat(impl, { env: { ANTHROPIC_API_KEY: 'sk-f661-host' } });
    expect(calls).toHaveLength(1);
    const { args, opts, stateFiles } = calls[0];
    expect(opts.env.ANTHROPIC_API_KEY).toBe('per-turn-f661');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:41661/');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(JSON.stringify(opts.env)).not.toContain('sk-f661-host');
    expect(args.join(' ')).not.toContain('sk-f661-host');
    expect(stateFiles.filter((f) => /credentials/.test(f))).toEqual([]);
  });

  test('a workspace seat on an API key refuses restricted networking, which would cut off its proxy', async () => {
    const { calls, impl } = recorder();
    const turn = claude.spawn('hi', {
      agentName: 'f661-seat',
      sessionId: null,
      cwd,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-f661-host' },
      environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust: 'workspace', network: { policy: 'restricted' } } },
      memoryLongTerm: '',
      _publicClaudeState: state,
      _detectBwrap: () => ({ available: true, path: 'bwrap' }),
      _startProviderProxy: async () => { throw new Error('no proxy expected'); },
      _spawnImpl: impl,
    });
    await expect(turn).rejects.toThrow(/shared bwrap networking/);
    expect(calls).toHaveLength(0);
  });

  // Off Linux there was never a copy, so the per-turn cleanup does not run.
  test('off Linux the per-turn cleanup deletes nothing under the seat\'s folder', async () => {
    const configDir = path.join(state, '.claude');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
    const { calls, impl } = recorder();
    await spawnSeat(impl, { env: { CLAUDE_CODE_OAUTH_TOKEN: OWN_TOKEN }, extra: { _platform: 'darwin' } });
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
  });

  test('a reply that echoes the person\'s token is redacted', async () => {
    const impl = () => fakeChild({ stdout: `leaked ${OWN_TOKEN}` });
    const res = await spawnSeat(impl, { env: { CLAUDE_CODE_OAUTH_TOKEN: OWN_TOKEN } });
    expect(res.text).not.toContain(OWN_TOKEN);
  });

  test('a public seat never runs on the person\'s subscription: no key, no turn, no copy', async () => {
    const { calls, impl } = recorder();
    await expect(spawnSeat(impl, { trust: 'public', env: { CLAUDE_CODE_OAUTH_TOKEN: OWN_TOKEN } }))
      .rejects.toThrow(/public Claude agents on Linux need ANTHROPIC_API_KEY/);
    expect(calls).toHaveLength(0);
    expect(filesUnder(state).filter((f) => /credentials/.test(f))).toEqual([]);
  });

  test('a public seat on an API key gets the proxy token, and neither the login nor the person\'s token', async () => {
    const { calls, impl } = recorder();
    await spawnSeat(impl, { trust: 'public', env: { ANTHROPIC_API_KEY: 'sk-f661-host', CLAUDE_CODE_OAUTH_TOKEN: OWN_TOKEN } });
    expect(calls).toHaveLength(1);
    const { opts, stateFiles } = calls[0];
    expect(opts.env.ANTHROPIC_API_KEY).toBe('per-turn-f661');
    expect(opts.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(stateFiles.filter((f) => /credentials/.test(f))).toEqual([]);
  });

  test('an old copy at our known path is removed on the seat\'s next turn, and nothing else is touched', async () => {
    const configDir = path.join(state, '.claude');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(configDir, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
    const staged = '..credentials.json.0b5e9a4c-1111-4222-8333-944455556666.tmp';
    fs.writeFileSync(path.join(configDir, staged), FAKE_LOGIN, { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{}\n');
    const { calls, impl } = recorder();
    await spawnSeat(impl, { env: { CLAUDE_CODE_OAUTH_TOKEN: OWN_TOKEN } });
    expect(calls[0].stateFiles).not.toContain(path.join('.claude', '.credentials.json'));
    expect(fs.existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, staged))).toBe(false);
    expect(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(operatorClaude, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
  });
});

describe('removeLegacyClaudeLoginCopies (F661)', () => {
  let root;
  let homes;
  let outside;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f661-sweep-'));
    homes = path.join(root, 'claude-homes');
    outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, '.credentials.json'), FAKE_LOGIN);
    fs.mkdirSync(path.join(outside, '.claude'));
    fs.writeFileSync(path.join(outside, '.claude', '.credentials.json'), FAKE_LOGIN);
    for (const seat of ['aaaa', 'bbbb-public']) {
      const dir = path.join(homes, seat, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, '..credentials.json.0b5e9a4c-1111-4222-8333-944455556666.tmp'), FAKE_LOGIN);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
      fs.writeFileSync(path.join(homes, seat, '.claude.json'), '{}\n');
    }
    fs.mkdirSync(path.join(homes, 'bbbb-public.login-turns'));
    fs.writeFileSync(path.join(homes, 'bbbb-public.login-turns', '12345-0b5e9a4c-1111-4222-8333-944455556666'), '');
    // A seat folder that is a link out of the root is not followed.
    fs.symlinkSync(outside, path.join(homes, 'linked'));
    // A file at the root named like a login is not a seat's copy.
    fs.writeFileSync(path.join(homes, '.credentials.json'), FAKE_LOGIN);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('removes only the login copies at our known paths', async () => {
    fs.writeFileSync(path.join(homes, 'bbbb-public.login-turns', 'not-a-marker'), '');
    await claudeModule.removeLegacyClaudeLoginCopies({ root: homes, platform: 'linux' });
    expect(filesUnder(homes)).toEqual([
      '.credentials.json',
      path.join('aaaa', '.claude', 'settings.json'),
      path.join('aaaa', '.claude.json'),
      path.join('bbbb-public', '.claude', 'settings.json'),
      path.join('bbbb-public', '.claude.json'),
      path.join('bbbb-public.login-turns', 'not-a-marker'),
      'linked',
    ].sort());
    // Only `<pid>-<uuid>` markers go; anything else keeps the folder.
    expect(fs.existsSync(path.join(homes, 'bbbb-public.login-turns', 'not-a-marker'))).toBe(true);
    expect(fs.existsSync(path.join(homes, 'bbbb-public.login-turns', '12345-0b5e9a4c-1111-4222-8333-944455556666'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
    expect(fs.readFileSync(path.join(outside, '.claude', '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
  });

  test('a missing root is fine', async () => {
    await expect(claudeModule.removeLegacyClaudeLoginCopies({ root: path.join(root, 'nope'), platform: 'linux' }))
      .resolves.toBeUndefined();
  });

  // A Seatbelt child can write its whole state folder, so on macOS the sweep
  // could be raced into deleting through a swapped-in link to ~/.claude. No
  // copy ever existed there: it returns before it even names a path.
  test.each(['darwin', 'win32'])('on %s it touches nothing, and never reads its root', async (platform) => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const opts = { get root() { throw new Error('the root was read'); } };
      await expect(claudeModule.removeLegacyClaudeLoginCopies(opts)).resolves.toBeUndefined();
      await claudeModule.removeLegacyClaudeLoginCopies({ root: homes, platform });
      await claude.removeLegacyLoginCopies();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
    expect(fs.readFileSync(path.join(homes, 'aaaa', '.claude', '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
    expect(fs.existsSync(path.join(homes, 'bbbb-public.login-turns'))).toBe(true);
  });

  test('the adapter runs it once per seat process', () => {
    expect(typeof claude.removeLegacyLoginCopies).toBe('function');
  });
});

describe('an unsandboxed Claude seat is unchanged (F661)', () => {
  test('it runs as the person, on their own HOME and login, and Commonly writes no login', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f661-plain-'));
    const operatorClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f661-plain-login-'));
    try {
      fs.writeFileSync(path.join(operatorClaude, '.credentials.json'), FAKE_LOGIN, { mode: 0o600 });
      const calls = [];
      await claude.spawn('hi', {
        agentName: 'f661-plain',
        sessionId: null,
        cwd,
        env: { PATH: process.env.PATH, HOME: '/home/person', CLAUDE_CONFIG_DIR: operatorClaude },
        memoryLongTerm: '',
        _spawnImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).not.toBe('bwrap');
      expect(calls[0].opts.env.HOME).toBe('/home/person');
      expect(calls[0].opts.env.CLAUDE_CONFIG_DIR).toBe(operatorClaude);
      expect(fs.readdirSync(operatorClaude)).toEqual(['.credentials.json']);
      expect(fs.readFileSync(path.join(operatorClaude, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
      expect(fs.readdirSync(cwd)).toEqual([]);
    } finally {
      for (const dir of [cwd, operatorClaude]) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
