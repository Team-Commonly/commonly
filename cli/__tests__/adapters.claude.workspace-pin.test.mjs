/**
 * adapters.claude.workspace-pin.test.mjs — F200
 *
 * A workspace-trust Claude seat's folder is not pinned to its own name (F197):
 * the operator may have chosen a link on purpose. A seat with write access can
 * still remove its project folder and leave a link there, and the next turn's
 * grant would then follow that link. The realpath the folder had on the seat's
 * first turn is recorded outside the seat's write grant, and a later turn whose
 * folder resolves elsewhere is refused before anything is spawned.
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
const { workspacePinFile, workspacePinDir } = await import('../src/lib/sandbox/workspace-pin.js');
const { spawnSync } = await import('child_process');

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

const recorder = () => {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild();
  };
  return { impl, calls };
};

const profileOf = (call) => call.args[call.args.indexOf('-p') + 1];

// Every subpath or literal the profile lets the jail write, in order.
const writeAllows = (profile) => [...profile.matchAll(
  /\(allow [^()]*file-write\*[^()]*\((subpath|literal) "([^"]+)"\)\)/g,
)].map((m) => ({ kind: m[1], path: m[2] }));

const covers = ({ kind, path: granted }, target) => (kind === 'literal'
  ? target === granted
  : target === granted || target.startsWith(`${granted}/`));

describe('a Seatbelt workspace seat\'s folder is held to the realpath it was first run in (F200)', () => {
  const originalPlatform = process.platform;
  let root;
  let cwd;
  let state;
  let decoy;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f200-sb-')));
    cwd = path.join(root, 'project');
    state = path.join(root, 'state');
    decoy = path.join(root, 'elsewhere');
    for (const dir of [cwd, state, decoy]) fs.mkdirSync(dir);
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: '/usr/bin/true\n' }
      : { status: 0, stdout: '' }));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const turn = (impl, { dir = cwd, allow = ['write'] } = {}) => claude.spawn('hi', {
    agentName: 'f200-seat',
    sessionId: null,
    cwd: dir,
    skillMountDir: root,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-f200-host-only' },
    environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'workspace', allow } },
    _publicClaudeState: state,
    _spawnImpl: impl,
    _startProviderProxy: async () => ({
      baseURL: 'http://127.0.0.1:41555/', token: 'per-turn-f200', port: 41555, close: async () => {},
    }),
  });

  const recorded = () => JSON.parse(fs.readFileSync(workspacePinFile(state), 'utf8'));

  test('a seat with no recorded value records its folder\'s realpath and runs', async () => {
    expect(fs.existsSync(workspacePinFile(state))).toBe(false);
    const { impl, calls } = recorder();
    await turn(impl);
    expect(calls).toHaveLength(1);
    expect(recorded().workspaces[cwd].realpath).toBe(cwd);
    expect(fs.statSync(workspacePinFile(state)).mode & 0o777).toBe(0o600);
  });

  test('a folder whose realpath is unchanged runs on every turn', async () => {
    const { impl, calls } = recorder();
    await turn(impl);
    await turn(impl);
    await turn(impl);
    expect(calls).toHaveLength(3);
    expect(profileOf(calls[2])).toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${cwd}"))`,
    );
  });

  test('an operator\'s link that was in place when the realpath was recorded keeps working', async () => {
    const link = path.join(root, 'project-link');
    fs.symlinkSync(cwd, link);
    const { impl, calls } = recorder();
    await turn(impl, { dir: link });
    await turn(impl, { dir: link });
    expect(calls).toHaveLength(2);
    expect(recorded().workspaces[link].realpath).toBe(cwd);
    expect(profileOf(calls[1])).toContain(
      `(allow file-read* file-test-existence file-write* (subpath "${cwd}"))`,
    );
  });

  test('a folder the seat replaced with a link after it was recorded refuses the turn before spawn', async () => {
    const { impl, calls } = recorder();
    await turn(impl);
    expect(calls).toHaveLength(1);
    // What a turn with write access can do: move its project aside and leave a
    // link to somewhere wider in its place.
    fs.renameSync(cwd, path.join(root, 'project-moved'));
    fs.symlinkSync(decoy, cwd);
    const error = await turn(impl).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(cwd);
    expect(error.message).toContain(decoy);
    expect(error.message).toMatch(/refusing a workspace turn/);
    // The fix is named: the file to remove, so the next turn records anew.
    expect(error.message).toContain(workspacePinFile(state));
    expect(calls).toHaveLength(1);
    // The record is not rewritten to the new target.
    expect(recorded().workspaces[cwd].realpath).toBe(cwd);
  });

  test('a recorded folder replaced by a link to nowhere is refused, not granted by name', async () => {
    const { impl, calls } = recorder();
    await turn(impl);
    fs.renameSync(cwd, path.join(root, 'project-moved'));
    fs.symlinkSync(path.join(root, 'not-yet'), cwd);
    const error = await turn(impl).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/refusing a workspace turn: .* now resolves to nothing/);
    expect(calls).toHaveLength(1);
  });

  test('an operator\'s link whose target the seat replaced with another link is refused', async () => {
    const link = path.join(root, 'project-link');
    fs.symlinkSync(cwd, link);
    const { impl, calls } = recorder();
    await turn(impl, { dir: link });
    fs.renameSync(cwd, path.join(root, 'project-moved'));
    fs.symlinkSync(decoy, cwd);
    await expect(turn(impl, { dir: link })).rejects.toThrow(/refusing a workspace turn/);
    expect(calls).toHaveLength(1);
  });

  // The check runs before the turn is prepared; the profile is built last. A
  // process left from an earlier turn can replace the folder in between, so
  // the profile grants only the realpath that was checked.
  test('a folder replaced while the turn is prepared is refused at the profile', async () => {
    const { impl, calls } = recorder();
    await turn(impl);
    const error = await claude.spawn('hi', {
      agentName: 'f200-seat',
      sessionId: null,
      cwd,
      skillMountDir: root,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-f200-host-only' },
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'workspace', allow: ['write'] } },
      _publicClaudeState: state,
      _spawnImpl: impl,
      _startProviderProxy: async () => {
        fs.renameSync(cwd, path.join(root, 'project-moved'));
        fs.symlinkSync(decoy, cwd);
        return { baseURL: 'http://127.0.0.1:41557/', token: 'per-turn-f200s', port: 41557, close: async () => {} };
      },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/refusing a workspace turn/);
    expect(error.message).toContain(decoy);
    expect(calls).toHaveLength(1);
  });

  test('the recorded file is outside every write grant of the profile, and denied by name', async () => {
    const { impl, calls } = recorder();
    await turn(impl);
    const profile = profileOf(calls[0]);
    const pinFile = workspacePinFile(state);
    const allows = writeAllows(profile);
    // The grants the seat does have are still there (the check is not vacuous).
    expect(allows.some((grant) => covers(grant, path.join(cwd, 'x')))).toBe(true);
    expect(allows.some((grant) => covers(grant, path.join(state, 'x')))).toBe(true);
    expect(allows.filter((grant) => covers(grant, pinFile))).toEqual([]);
    // Denied by name too, after the workspace grant (later rules win), so a
    // workspace that contained it would still not reach it.
    const deny = `(deny file-write* (subpath "${workspacePinDir(state)}"))`;
    expect(profile).toContain(deny);
    expect(profile.indexOf(deny)).toBeGreaterThan(
      profile.indexOf(`file-write* (subpath "${cwd}"))`),
    );
  });

  test('a workspace that contains the recorded file is refused before spawn', async () => {
    const { impl, calls } = recorder();
    const error = await turn(impl, { dir: root }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/contains this agent's own record/);
    expect(calls).toHaveLength(0);
  });

  test('a recorded file that is a link is refused, not read through', async () => {
    fs.mkdirSync(workspacePinDir(state), { recursive: true });
    const elsewhere = path.join(decoy, 'pins.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ workspaces: { [cwd]: { realpath: decoy } } }));
    fs.symlinkSync(elsewhere, workspacePinFile(state));
    const { impl, calls } = recorder();
    await expect(turn(impl)).rejects.toThrow(/not a regular file/);
    expect(calls).toHaveLength(0);
  });

  test('a public seat records nothing: its folder is pinned to its own name (F197)', async () => {
    const { impl, calls } = recorder();
    await claude.spawn('hi', {
      agentName: 'f200-public',
      sessionId: null,
      cwd,
      skillMountDir: root,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-f200-host-only' },
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'public' } },
      _publicClaudeState: state,
      _spawnImpl: impl,
      _startProviderProxy: async () => ({
        baseURL: 'http://127.0.0.1:41556/', token: 'per-turn-f200p', port: 41556, close: async () => {},
      }),
    });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(workspacePinFile(state))).toBe(false);
  });
});

describe('a bwrap workspace seat\'s folder is held to the realpath it was first run in (F200)', () => {
  const originalPlatform = process.platform;
  let root;
  let cwd;
  let state;
  let decoy;
  let operatorClaude;
  let claudeInstall;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f200-bw-')));
    cwd = path.join(root, 'project');
    state = path.join(root, 'state');
    decoy = path.join(root, 'elsewhere');
    operatorClaude = path.join(root, 'operator-claude');
    claudeInstall = path.join(root, 'install');
    for (const dir of [cwd, state, decoy, operatorClaude, claudeInstall]) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(cwd, '.git'));
    fs.writeFileSync(path.join(claudeInstall, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(operatorClaude, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"operator-only","refreshToken":"r"}}\n', { mode: 0o600 });
    spawnSync.mockImplementation((cmd) => (cmd === 'which'
      ? { status: 0, stdout: `${path.join(claudeInstall, 'claude')}\n` } : undefined));
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    spawnSync.mockReset();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const turn = (impl) => claude.spawn('hi', {
    agentName: 'f200-bwrap-seat',
    sessionId: null,
    cwd,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude },
    environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust: 'workspace', allow: ['write'] } },
    memoryLongTerm: '',
    _publicClaudeState: state,
    _detectBwrap: () => ({ available: true, path: 'bwrap' }),
    _spawnImpl: impl,
  });

  test('records on the first turn, runs while unchanged, and refuses a folder replaced by a link', async () => {
    const { impl, calls } = recorder();
    await turn(impl);
    await turn(impl);
    expect(calls).toHaveLength(2);
    fs.renameSync(cwd, path.join(root, 'project-moved'));
    fs.symlinkSync(decoy, cwd);
    await expect(turn(impl)).rejects.toThrow(/refusing a workspace turn/);
    expect(calls).toHaveLength(2);
  });
});
