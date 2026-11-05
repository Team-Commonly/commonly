/**
 * adapters.claude.state-symlinks.test.mjs — F153
 *
 * A confined Claude seat's state folder is writable by the seat itself, on
 * Seatbelt and on bwrap alike. Whatever a previous (or concurrent) turn left
 * there is the child's choice, so every write the host makes into that folder
 * must not follow a link the child planted: not the auth-metadata file, not a
 * chmod of a subfolder, not a keychain link made inside a subfolder, and not
 * the removal of the login copy after the turn.
 *
 * Also F153: a Seatbelt seat with no key that fails "Not logged in" says how to
 * give it one, as the bwrap seat does.
 *
 * Uses ctx._spawnImpl, ctx._detectBwrap and ctx._startProviderProxy, so no real
 * claude, sandbox-exec, bwrap or network runs.
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

const DECOY_TEXT = 'the person\'s own file — the host must never write here\n';

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

const modeOf = (p) => fs.statSync(p).mode & 0o777;
const lstatOrNull = (p) => {
  try { return fs.lstatSync(p); } catch { return null; }
};

describe('a Seatbelt Claude seat\'s state folder (F153)', () => {
  const originalPlatform = process.platform;
  let root;
  let cwd;
  let state;
  let decoyDir;
  let decoyFile;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f153-sb-'));
    cwd = path.join(root, 'cwd');
    state = path.join(root, 'state');
    decoyDir = path.join(root, 'decoy');
    decoyFile = path.join(decoyDir, 'target.json');
    for (const dir of [cwd, state, decoyDir]) fs.mkdirSync(dir);
    fs.chmodSync(decoyDir, 0o755);
    fs.writeFileSync(decoyFile, DECOY_TEXT, { mode: 0o644 });
    fs.chmodSync(decoyFile, 0o644);
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: '/usr/bin/true\n' }
      : { status: 0, stdout: '' }));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const okImpl = ({ code = 0, stdout = 'ok' } = {}) => {
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return fakeChild({ stdout, code });
    };
    return { impl, calls };
  };

  const proxyStart = async () => ({
    baseURL: 'http://127.0.0.1:41553/', token: 'per-turn-f153', port: 41553, close: async () => {},
  });

  const seatbeltSpawn = (impl, { key = false, trust = 'public' } = {}) => claude.spawn('hi', {
    agentName: 'f153-seat',
    sessionId: null,
    cwd,
    skillMountDir: root,
    env: { PATH: process.env.PATH, ...(key ? { ANTHROPIC_API_KEY: 'sk-ant-f153-host-only' } : {}) },
    environment: { model: 'test-model', sandbox: { mode: 'workspace', trust } },
    _publicClaudeState: state,
    _spawnImpl: impl,
    _startProviderProxy: proxyStart,
  });

  describe.each([
    ['keychain login', false],
    ['API key through the proxy', true],
  ])('a seat on its %s', (_label, key) => {
    test('a .claude.json link left in the state folder is replaced, never written through', async () => {
      const configPath = path.join(state, '.claude.json');
      fs.symlinkSync(decoyFile, configPath);
      const { impl, calls } = okImpl();
      await seatbeltSpawn(impl, { key });
      expect(calls).toHaveLength(1);
      // The link target is untouched: same bytes, same mode.
      expect(fs.readFileSync(decoyFile, 'utf8')).toBe(DECOY_TEXT);
      expect(modeOf(decoyFile)).toBe(0o644);
      // The seat's own file is a real 0600 file carrying the auth metadata.
      const written = fs.lstatSync(configPath);
      expect(written.isSymbolicLink()).toBe(false);
      expect(written.isFile()).toBe(true);
      expect(written.mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).hasCompletedOnboarding).toBe(true);
      // No staged temp file is left beside it.
      expect(fs.readdirSync(state).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    test.each(['tmp', 'Library'])('a %s link left in the state folder is refused, and its target is not touched', async (name) => {
      fs.symlinkSync(decoyDir, path.join(state, name));
      const { impl, calls } = okImpl();
      await expect(seatbeltSpawn(impl, { key })).rejects.toThrow(/not a directory/);
      expect(calls).toHaveLength(0);
      // Not chmodded to 0700, and no Keychains link made inside it.
      expect(modeOf(decoyDir)).toBe(0o755);
      expect(fs.readdirSync(decoyDir)).toEqual(['target.json']);
    });
  });

  test('a seat with no key that is not logged in is told how to give it one', async () => {
    const { impl } = okImpl({ code: 1, stdout: 'Not logged in · Please run /login' });
    const error = await seatbeltSpawn(impl).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Not logged in/);
    expect(error.message).toContain('set ANTHROPIC_API_KEY (in the service env for daemon seats)');
  });

  test('a key seat\'s failure carries no key hint: it already has one', async () => {
    const { impl } = okImpl({ code: 1, stdout: 'Not logged in · Please run /login' });
    const error = await seatbeltSpawn(impl, { key: true }).catch((err) => err);
    expect(error.message).toMatch(/Not logged in/);
    expect(error.message).not.toContain('set ANTHROPIC_API_KEY');
  });

  test('an unrelated failure of a keyless seat carries no key hint', async () => {
    const { impl } = okImpl({ code: 1, stdout: 'boom' });
    const error = await seatbeltSpawn(impl).catch((err) => err);
    expect(error.message).not.toContain('set ANTHROPIC_API_KEY');
  });
});

describe('a bwrap Claude seat\'s state folder (F153)', () => {
  const originalPlatform = process.platform;
  let root;
  let cwd;
  let state;
  let operatorClaude;
  let claudeInstall;
  let decoyDir;
  const OPERATOR_LOGIN = '{"claudeAiOauth":{"accessToken":"operator-only","refreshToken":"r"}}\n';

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f153-bw-'));
    cwd = path.join(root, 'cwd');
    state = path.join(root, 'state');
    operatorClaude = path.join(root, 'operator-claude');
    claudeInstall = path.join(root, 'install');
    decoyDir = path.join(root, 'decoy');
    for (const dir of [cwd, state, operatorClaude, claudeInstall, decoyDir]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(claudeInstall, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(operatorClaude, '.credentials.json'), OPERATOR_LOGIN, { mode: 0o600 });
    // The decoy stands in for the person's real ~/.claude: the file a removal
    // through a planted link would delete.
    fs.writeFileSync(path.join(decoyDir, '.credentials.json'), DECOY_TEXT, { mode: 0o600 });
    fs.writeFileSync(path.join(decoyDir, '.claude.json'), DECOY_TEXT, { mode: 0o644 });
    fs.chmodSync(path.join(decoyDir, '.claude.json'), 0o644);
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: `${path.join(claudeInstall, 'claude')}\n` } : undefined));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const bwrapSpawn = (impl, { trust = 'public', env = {} } = {}) => claude.spawn('hi', {
    agentName: 'f153-bwrap-seat',
    sessionId: null,
    cwd,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude, ...env },
    environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust } },
    memoryLongTerm: '',
    _publicClaudeState: state,
    _detectBwrap: () => ({ available: true, path: 'bwrap' }),
    _startProviderProxy: async () => ({
      baseURL: 'http://127.0.0.1:41554/', token: 'per-turn-f153-bw', port: 41554, close: async () => {},
    }),
    _spawnImpl: impl,
  });

  test('a .claude.json link is replaced, never written through (bwrap already did this; kept as a guard)', async () => {
    fs.symlinkSync(path.join(decoyDir, '.claude.json'), path.join(state, '.claude.json'));
    const calls = [];
    await bwrapSpawn((cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild({ stdout: 'ok' }); });
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(path.join(decoyDir, '.claude.json'), 'utf8')).toBe(DECOY_TEXT);
    expect(modeOf(path.join(decoyDir, '.claude.json'))).toBe(0o644);
    const written = fs.lstatSync(path.join(state, '.claude.json'));
    expect(written.isFile()).toBe(true);
    expect(written.mode & 0o777).toBe(0o600);
  });

  // The public login seat's copy is removed after its turn. A turn that swaps
  // its .claude folder for a link to the person's own ~/.claude would have the
  // host delete the person's login through it.
  test('the login copy is removed after the turn without following a .claude link the turn planted', async () => {
    const calls = [];
    await bwrapSpawn((cmd, args, opts) => {
      // Play the confined child: move the real folder aside and plant a link.
      const configDir = path.join(state, '.claude');
      fs.renameSync(configDir, path.join(state, '.claude-moved'));
      fs.symlinkSync(decoyDir, configDir);
      calls.push({ cmd, args, opts });
      return fakeChild({ stdout: 'ok' });
    });
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(path.join(decoyDir, '.credentials.json'), 'utf8')).toBe(DECOY_TEXT);
    // The planted link itself is left in place for the next turn to refuse.
    expect(lstatOrNull(path.join(state, '.claude')).isSymbolicLink()).toBe(true);
  });

  test('the next turn refuses a .claude link, before copying the login anywhere', async () => {
    fs.symlinkSync(decoyDir, path.join(state, '.claude'));
    const calls = [];
    await expect(bwrapSpawn((cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); }))
      .rejects.toThrow(/not a directory/);
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(decoyDir, '.credentials.json'), 'utf8')).toBe(DECOY_TEXT);
  });

  // The open question F153 carried: which login a Linux workspace seat uses
  // when the host env has a key. Pinned here as it stands: the login. The key
  // never reaches the jail, and no proxy starts (macOS prefers the key, F151).
  test('a Linux workspace seat with ANTHROPIC_API_KEY set still runs on the login copy, not the key', async () => {
    const calls = [];
    let started = 0;
    await claude.spawn('hi', {
      agentName: 'f153-bwrap-ws',
      sessionId: null,
      cwd,
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude, ANTHROPIC_API_KEY: 'sk-ant-f153-ws' },
      environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust: 'workspace' } },
      memoryLongTerm: '',
      _publicClaudeState: state,
      _detectBwrap: () => ({ available: true, path: 'bwrap' }),
      _startProviderProxy: async () => { started += 1; throw new Error('no proxy expected'); },
      _spawnImpl: (cmd, args, opts) => {
        const home = args[args.indexOf('HOME') + 1];
        const loginPath = path.join(home, '.claude', '.credentials.json');
        calls.push({ cmd, args, opts, login: fs.existsSync(loginPath) ? fs.readFileSync(loginPath, 'utf8') : null });
        return fakeChild({ stdout: 'ok' });
      },
    });
    expect(started).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].opts.env)).not.toContain('sk-ant-f153-ws');
    expect(calls[0].args.join('\n')).not.toContain('sk-ant-f153-ws');
    expect(JSON.parse(calls[0].login).claudeAiOauth.accessToken).toBe('operator-only');
  });
});
