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

const claudeModule = await import('../src/lib/adapters/claude.js');
const claude = claudeModule.default;
const { ensurePrivateDir, replacePrivateFile } = claudeModule;
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

  // A Seatbelt write rule on the state folder covers the folder itself, so the
  // child can remove it and leave a link in its place (verified with
  // sandbox-exec). The next turn must refuse before it chmods, creates or links
  // anything through it.
  describe.each([
    ['keychain login', false],
    ['API key through the proxy', true],
  ])('a seat on its %s whose state folder the child replaced with a link', (_label, key) => {
    test('refuses the turn, names the link, and leaves the link target as it was', async () => {
      fs.rmdirSync(state);
      fs.symlinkSync(decoyDir, state);
      const { impl, calls } = okImpl();
      const error = await seatbeltSpawn(impl, { key }).catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(state);
      expect(error.message).toMatch(/symbolic link/);
      expect(error.message).toMatch(/remove the link/i);
      expect(calls).toHaveLength(0);
      expect(modeOf(decoyDir)).toBe(0o755);
      // No tmp or Library made there, so no Keychains link inside it either.
      expect(fs.readdirSync(decoyDir)).toEqual(['target.json']);
      expect(lstatOrNull(path.join(decoyDir, 'Library', 'Keychains'))).toBeNull();
    });
  });

  // The state folder is checked when it is prepared, and again where the
  // profile grants it: a process left from an earlier turn can replace it in
  // between. Here it is replaced after preparation, while the provider proxy
  // starts, which is the last step before the profile is built.
  test('a state folder replaced with a link after it was prepared is refused at the profile, by name', async () => {
    const { impl, calls } = okImpl();
    const swapThenStart = async () => {
      fs.renameSync(state, path.join(root, 'state-moved'));
      fs.symlinkSync(decoyDir, state);
      return proxyStart();
    };
    const error = await claude.spawn('hi', {
      agentName: 'f153-seat',
      sessionId: null,
      cwd,
      skillMountDir: root,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-f153-host-only' },
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'public' } },
      _publicClaudeState: state,
      _spawnImpl: impl,
      _startProviderProxy: swapThenStart,
    }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(state);
    expect(error.message).toMatch(/refusing a confined turn: its writable state folder/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(decoyDir)).toEqual(['target.json']);
  });

  test('an unchanged state folder is granted to the turn as before', async () => {
    const { impl, calls } = okImpl();
    await seatbeltSpawn(impl, { key: true });
    expect(calls).toHaveLength(1);
    const profile = calls[0].args[calls[0].args.indexOf('-p') + 1];
    expect(profile).toContain(`file-write* (subpath "${fs.realpathSync(state)}"))`);
  });

  // A workspace seat's folder is the operator's choice and may be a link; a
  // public seat's is a scratch folder the CLI made, and is pinned (F197).
  const linkCwdTo = () => {
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    fs.rmdirSync(cwd);
    fs.symlinkSync(project, cwd);
    return project;
  };

  test('a workspace seat whose writable folder is the operator\'s link runs, granted at the link target', async () => {
    const project = linkCwdTo();
    const { impl, calls } = okImpl();
    await claude.spawn('hi', {
      agentName: 'f197-workspace-seat',
      sessionId: null,
      cwd,
      skillMountDir: root,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-f197-host-only' },
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'workspace', allow: ['write'] } },
      _publicClaudeState: state,
      _spawnImpl: impl,
      _startProviderProxy: proxyStart,
    });
    expect(calls).toHaveLength(1);
    const profile = calls[0].args[calls[0].args.indexOf('-p') + 1];
    expect(profile).toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${fs.realpathSync(project)}"))`,
    );
  });

  test('a public seat whose writable folder is a link is refused, by name', async () => {
    linkCwdTo();
    const { impl, calls } = okImpl();
    const error = await seatbeltSpawn(impl, { key: true }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(cwd);
    expect(error.message).toMatch(/its writable workspace/);
    expect(calls).toHaveLength(0);
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

  // The structural fix for the check-then-use race: inside the jail .claude and
  // tmp are mount points of their own, which the child cannot rename or replace
  // (EBUSY), so the host's check of them holds for the whole turn.
  test.each([
    ['public', {}],
    ['public', { ANTHROPIC_API_KEY: 'sk-ant-f153-bw-key' }],
    ['workspace', {}],
  ])('a %s seat binds .claude and tmp on their own, after the state folder', async (trust, env) => {
    const calls = [];
    await bwrapSpawn((cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild({ stdout: 'ok' }); }, { trust, env });
    expect(calls).toHaveLength(1);
    const { args } = calls[0];
    const bindAt = (p) => args.findIndex((arg, i) => arg === '--bind' && args[i + 1] === p && args[i + 2] === p);
    const stateBind = bindAt(state);
    expect(stateBind).toBeGreaterThanOrEqual(0);
    for (const name of ['.claude', 'tmp']) {
      expect(bindAt(path.join(state, name))).toBeGreaterThan(stateBind);
    }
    // Both exist as real directories before the jail starts, or bwrap fails.
    for (const name of ['.claude', 'tmp']) {
      expect(fs.lstatSync(path.join(state, name)).isDirectory()).toBe(true);
    }
  });

  // A staged copy of the login a crashed turn left behind holds the access
  // token. The removal after the turn takes it with the login copy.
  test('a staged login copy left in .claude is removed with the login after the turn', async () => {
    const configDir = path.join(state, '.claude');
    const staged = path.join(configDir, '..credentials.json.0b5e9a4c-1111-4222-8333-944455556666.tmp');
    const unrelated = path.join(configDir, 'settings.json');
    await bwrapSpawn(() => {
      fs.writeFileSync(staged, '{"claudeAiOauth":{"accessToken":"left-behind"}}\n', { mode: 0o600 });
      fs.writeFileSync(unrelated, '{}\n');
      return fakeChild({ stdout: 'ok' });
    });
    expect(lstatOrNull(path.join(configDir, '.credentials.json'))).toBeNull();
    expect(lstatOrNull(staged)).toBeNull();
    // Only the login's own files go.
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('{}\n');
  });

  test('the next turn refuses a state folder replaced with a link, before making or chmodding anything through it', async () => {
    fs.rmdirSync(state);
    fs.symlinkSync(decoyDir, state);
    fs.chmodSync(decoyDir, 0o755);
    const calls = [];
    const error = await bwrapSpawn((cmd, args, opts) => { calls.push({ cmd, args, opts }); return fakeChild(); })
      .catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/symbolic link/);
    expect(error.message).toMatch(/remove the link/i);
    expect(calls).toHaveLength(0);
    expect(modeOf(decoyDir)).toBe(0o755);
    expect(fs.readdirSync(decoyDir).sort()).toEqual(['.claude.json', '.credentials.json']);
    expect(modeOf(path.join(decoyDir, '.claude.json'))).toBe(0o644);
    expect(fs.readFileSync(path.join(decoyDir, '.credentials.json'), 'utf8')).toBe(DECOY_TEXT);
  });

  // A child can leave a directory under a staged copy's name. Removing the
  // login after the turn skips it rather than failing on it, and still removes
  // the login copy itself.
  test('a directory named like a staged login copy does not break the removal of the login', async () => {
    const configDir = path.join(state, '.claude');
    const stagedDir = path.join(configDir, '..credentials.json.0b5e9a4c-1111-4222-8333-944455556666.tmp');
    const calls = [];
    await bwrapSpawn((cmd, args, opts) => {
      fs.mkdirSync(stagedDir);
      fs.writeFileSync(path.join(stagedDir, 'inside'), 'x');
      calls.push({ cmd, args, opts });
      return fakeChild({ stdout: 'ok' });
    });
    expect(calls).toHaveLength(1);
    expect(lstatOrNull(path.join(configDir, '.credentials.json'))).toBeNull();
    expect(fs.lstatSync(stagedDir).isDirectory()).toBe(true);
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

describe('the host\'s writes into a child-writable folder (F153)', () => {
  let root;
  let decoyDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f153-fs-'));
    decoyDir = path.join(root, 'decoy');
    fs.mkdirSync(decoyDir);
    fs.chmodSync(decoyDir, 0o755);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Seatbelt has no PID namespace, so a process an earlier turn left running
  // can swap the folder for a link after the host checked it. The chmod goes
  // through a handle opened without following a link, so it never reaches the
  // link's target.
  test('a folder swapped for a link after the check is refused, and the link target keeps its mode', async () => {
    const dir = path.join(root, 'tmp');
    fs.mkdirSync(dir, { mode: 0o755 });
    await expect(ensurePrivateDir(dir, {
      _afterCheck: async () => {
        fs.renameSync(dir, path.join(root, 'tmp-moved'));
        fs.symlinkSync(decoyDir, dir);
      },
    })).rejects.toThrow(/not a directory/);
    expect(modeOf(decoyDir)).toBe(0o755);
  });

  test('a real folder is made 0700, and a missing one is created 0700', async () => {
    const existing = path.join(root, 'existing');
    fs.mkdirSync(existing);
    fs.chmodSync(existing, 0o755);
    await ensurePrivateDir(existing);
    expect(modeOf(existing)).toBe(0o700);
    const created = path.join(root, 'created');
    await ensurePrivateDir(created);
    expect(fs.lstatSync(created).isDirectory()).toBe(true);
    expect(modeOf(created)).toBe(0o700);
  });

  // The staged copy sits in a folder a concurrent child of the same seat can
  // write. A link swapped in for it after the exclusive create must not carry a
  // chmod to the link's target.
  test('a staged copy swapped for a link after its create is not chmodded through', async () => {
    const dir = path.join(root, 'state');
    fs.mkdirSync(dir, { mode: 0o700 });
    const decoyFile = path.join(decoyDir, 'target.json');
    fs.writeFileSync(decoyFile, 'decoy\n');
    fs.chmodSync(decoyFile, 0o644);
    const swappingWrite = async (file, content, opts) => {
      await fs.promises.writeFile(file, content, opts);
      fs.rmSync(file);
      fs.symlinkSync(decoyFile, file);
    };
    await replacePrivateFile(dir, '.claude.json', '{}\n', { _writeFile: swappingWrite }).catch(() => {});
    expect(modeOf(decoyFile)).toBe(0o644);
    expect(fs.readFileSync(decoyFile, 'utf8')).toBe('decoy\n');
  });

  test('the written file is 0600 from its create, even under a permissive umask', async () => {
    const dir = path.join(root, 'state');
    fs.mkdirSync(dir, { mode: 0o700 });
    const previous = process.umask(0);
    try {
      await replacePrivateFile(dir, '.claude.json', '{}\n');
    } finally {
      process.umask(previous);
    }
    const written = fs.lstatSync(path.join(dir, '.claude.json'));
    expect(written.isFile()).toBe(true);
    expect(written.mode & 0o777).toBe(0o600);
  });

  // The staged copy holds what the host is writing (the access token, for the
  // login), so a write that fails partway must not leave it beside the target.
  test('a write that fails partway leaves no staged copy behind', async () => {
    const dir = path.join(root, 'state');
    fs.mkdirSync(dir, { mode: 0o700 });
    const failingWrite = async (file, content, opts) => {
      fs.writeFileSync(file, String(content).slice(0, 8), opts);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    await expect(replacePrivateFile(dir, '.credentials.json', 'secret-access-token', { _writeFile: failingWrite }))
      .rejects.toThrow(/ENOSPC/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
