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
const { holdWorkspaceRealpath, workspacePinFile, workspacePinDir } = await import('../src/lib/sandbox/workspace-pin.js');
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

  const recordFile = (dir = cwd) => workspacePinFile(state, dir);
  const recorded = (dir = cwd) => JSON.parse(fs.readFileSync(recordFile(dir), 'utf8'));

  test('a seat with no recorded value records its folder\'s realpath and runs', async () => {
    expect(fs.existsSync(recordFile())).toBe(false);
    const { impl, calls } = recorder();
    await turn(impl);
    expect(calls).toHaveLength(1);
    expect(recorded().realpath).toBe(cwd);
    expect(fs.statSync(recordFile()).mode & 0o777).toBe(0o600);
  });

  // An existing seat is recorded on its first turn after the update, so the
  // operator gets one line to check that it recorded the folder they expect.
  test('the first record is logged once, naming the path and its realpath', async () => {
    const link = path.join(root, 'project-link');
    fs.symlinkSync(cwd, link);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { impl } = recorder();
      await turn(impl, { dir: link });
      await turn(impl, { dir: link });
      const lines = warn.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('recorded '));
      expect(lines).toEqual([expect.stringContaining(`recorded ${link} → ${cwd}`)]);
    } finally {
      warn.mockRestore();
    }
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
    expect(recorded(link).realpath).toBe(cwd);
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
    expect(error.message).toContain(recordFile());
    expect(calls).toHaveLength(1);
    // The record is not rewritten to the new target.
    expect(recorded().realpath).toBe(cwd);
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
    const pinFile = recordFile();
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

  test('a record under a folder whose name starts with two dots still counts as inside the workspace', async () => {
    const workspace = path.join(root, 'project');
    fs.mkdirSync(path.join(workspace, '..cache', 'homes'), { recursive: true });
    const error = await holdWorkspaceRealpath({
      cwd: workspace,
      statePath: path.join(workspace, '..cache', 'homes', 'state'),
    }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/contains this agent's own record/);
  });

  test.each([
    ['corrupt JSON', '{"realpath": '],
    ['null', 'null'],
    ['a string', JSON.stringify('/somewhere')],
    ['a bare array', JSON.stringify([])],
    ['no realpath', JSON.stringify({ other: 'x' })],
    ['an empty realpath', JSON.stringify({ realpath: '' })],
    ['a realpath that is not a string', JSON.stringify({ realpath: 7 })],
  ])('a record holding %s is refused before spawn, and left as it was', async (_label, content) => {
    fs.mkdirSync(workspacePinDir(state), { recursive: true });
    fs.writeFileSync(recordFile(), content);
    const { impl, calls } = recorder();
    const error = await turn(impl).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/cannot be read/);
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(recordFile(), 'utf8')).toBe(content);
  });

  test('each folder has its own record, so a bad one does not refuse another folder', async () => {
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    fs.mkdirSync(workspacePinDir(state), { recursive: true });
    fs.writeFileSync(recordFile(other), 'not json');
    expect(recordFile(other)).not.toBe(recordFile());
    const { impl, calls } = recorder();
    await turn(impl);
    expect(calls).toHaveLength(1);
    await expect(turn(impl, { dir: other })).rejects.toThrow(/cannot be read/);
    expect(calls).toHaveLength(1);
  });

  test('a folder with no record that does not exist is refused before spawn, and nothing is recorded', async () => {
    const missing = path.join(root, 'not-there');
    const { impl, calls } = recorder();
    const error = await turn(impl, { dir: missing }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/refusing a workspace turn/);
    expect(error.message).toContain(missing);
    expect(error.message).toMatch(/does not resolve to a folder/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(recordFile(missing))).toBe(false);
  });

  // Removing the record trusts whatever the folder resolves to now, so the
  // operator is asked to look first.
  test('an unreadable record\'s recovery text asks the operator to confirm the folder before removing it', async () => {
    fs.mkdirSync(workspacePinDir(state), { recursive: true });
    fs.writeFileSync(recordFile(), 'not json');
    const error = await turn(recorder().impl).catch((err) => err);
    const confirm = error.message.search(/confirm .* resolves where you expect/);
    expect(confirm).toBeGreaterThan(-1);
    expect(error.message.indexOf('remove')).toBeGreaterThan(confirm);
  });

  test('a recorded file that is a link is refused, not read through', async () => {
    fs.mkdirSync(workspacePinDir(state), { recursive: true });
    const elsewhere = path.join(decoy, 'pins.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ realpath: decoy }));
    fs.symlinkSync(elsewhere, recordFile());
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
    expect(fs.existsSync(recordFile())).toBe(false);
  });
});

describe('two turns recording at once (F200)', () => {
  let root;
  let state;
  const quiet = () => {};

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-f200-race-')));
    state = path.join(root, 'state');
    fs.mkdirSync(state);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // Holds every writer at the staged write until `count` have arrived, so each
  // has already found no record before any of them can publish one.
  const barrier = (count) => {
    let arrived = 0;
    let open;
    const opened = new Promise((resolve) => { open = resolve; });
    return async (...args) => {
      arrived += 1;
      if (arrived === count) open();
      await opened;
      return fs.promises.writeFile(...args);
    };
  };
  const folder = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return dir;
  };

  test('holds for two folders of one seat both survive', async () => {
    const [a, b] = [folder('a'), folder('b')];
    const _writeFile = barrier(2);
    await Promise.all([a, b].map((cwd) => holdWorkspaceRealpath({
      cwd, statePath: state, log: quiet, _writeFile,
    })));
    for (const dir of [a, b]) {
      expect(JSON.parse(fs.readFileSync(workspacePinFile(state, dir), 'utf8')).realpath).toBe(dir);
    }
    // Each is held: replacing one is refused, not recorded again.
    fs.renameSync(a, path.join(root, 'a-moved'));
    fs.symlinkSync(folder('elsewhere'), a);
    await expect(holdWorkspaceRealpath({ cwd: a, statePath: state, log: quiet }))
      .rejects.toThrow(/refusing a workspace turn/);
  });

  test('two holds of one folder that resolve differently give exactly one winner', async () => {
    const cwd = folder('project');
    const [first, second] = [folder('first'), folder('second')];
    const _writeFile = barrier(2);
    const log = jest.fn();
    const results = await Promise.allSettled([first, second].map((target) => holdWorkspaceRealpath({
      cwd, statePath: state, log, _writeFile, _realpath: async () => target,
    })));
    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason.message).toMatch(/refusing a workspace turn/);
    // The record is the winner's, and only the winner reported recording it.
    expect(JSON.parse(fs.readFileSync(workspacePinFile(state, cwd), 'utf8')).realpath).toBe(won[0].value);
    expect(log).toHaveBeenCalledTimes(1);
    // No staged copy is left beside it.
    expect(fs.readdirSync(workspacePinDir(state))).toEqual([path.basename(workspacePinFile(state, cwd))]);
  });

  test('two holds of one folder that resolve alike both pass', async () => {
    const cwd = folder('project');
    const _writeFile = barrier(2);
    const log = jest.fn();
    const held = await Promise.all([1, 2].map(() => holdWorkspaceRealpath({
      cwd, statePath: state, log, _writeFile,
    })));
    expect(held).toEqual([cwd, cwd]);
    expect(log).toHaveBeenCalledTimes(1);
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

  const turn = (impl, dir = cwd, extra = {}) => claude.spawn('hi', {
    agentName: 'f200-bwrap-seat',
    sessionId: null,
    cwd: dir,
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: operatorClaude },
    environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust: 'workspace', allow: ['write'] } },
    memoryLongTerm: '',
    _publicClaudeState: state,
    _detectBwrap: () => ({ available: true, path: 'bwrap' }),
    _spawnImpl: impl,
    ...extra,
  });
  const bindTriples = (args) => args.flatMap((arg, i) => (
    ['--bind', '--ro-bind', '--bind-fd', '--ro-bind-fd'].includes(arg) ? [[arg, args[i + 1], args[i + 2]]] : []));

  // bwrap resolves a bind source when the jail starts, after the check. The
  // checked realpath is the source, mounted at the path the seat was given,
  // so a swap after the check cannot move the mount.
  test('binds the checked realpath at the given path, with .git held read-only from it', async () => {
    const link = path.join(root, 'project-link');
    fs.symlinkSync(cwd, link);
    const { impl, calls } = recorder();
    await turn(impl, link);
    expect(calls).toHaveLength(1);
    const { args } = calls[0];
    const triples = args.flatMap((arg, i) => (
      ['--bind', '--ro-bind'].includes(arg) ? [[arg, args[i + 1], args[i + 2]]] : []));
    expect(triples).toContainEqual(['--bind', cwd, link]);
    expect(triples).toContainEqual(['--ro-bind', path.join(cwd, '.git'), path.join(link, '.git')]);
    expect(triples.filter(([, src]) => src === link)).toEqual([]);
    expect(args[args.indexOf('--chdir') + 1]).toBe(link);
  });

  // F200: the fresh-session retry is the same turn in the same held folder.
  test('a fresh-session retry binds the checked realpath too', async () => {
    const link = path.join(root, 'project-link');
    fs.symlinkSync(cwd, link);
    const calls = [];
    const impl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (calls.length > 1) return fakeChild();
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setTimeout(() => {
        proc.stderr.emit('data', Buffer.from('Error: Session ID abc-123 is already in use.'));
        proc.emit('close', 1);
      }, 0);
      return proc;
    };
    await turn(impl, link, { sessionId: 'abc-123' });
    expect(calls).toHaveLength(2);
    expect(bindTriples(calls[1].args)).toContainEqual(['--bind', cwd, link]);
    expect(bindTriples(calls[1].args).filter(([, src]) => src === link)).toEqual([]);
  });

  // F211: where bwrap takes descriptors, the checked folder and its .git are
  // opened, checked, and mounted from the open descriptors, so a swap in the
  // startup window cannot move either mount.
  describe('with a bwrap that binds descriptors', () => {
    // What /proc/self/fd/N reads on Linux, found here by inode.
    const fdPathOf = (fd, extra = []) => {
      const { ino, dev } = fs.fstatSync(fd);
      const known = [cwd, path.join(cwd, '.git'), ...extra]
        .find((p) => { const st = fs.statSync(p); return st.ino === ino && st.dev === dev; });
      return known || '/somewhere/else';
    };
    const fdTurn = (impl, dir = cwd, extra = {}) => turn(impl, dir, {
      _detectBwrap: () => ({ available: true, path: 'bwrap', bindFd: true }),
      _fdPath: fdPathOf,
      ...extra,
    });

    test('mounts the workspace and its .git from descriptors 3 and 4, and closes them after the spawn', async () => {
      const link = path.join(root, 'project-link');
      fs.symlinkSync(cwd, link);
      const { impl, calls } = recorder();
      await fdTurn(impl, link);
      expect(calls).toHaveLength(1);
      const { args, opts } = calls[0];
      const triples = bindTriples(args);
      expect(triples).toContainEqual(['--bind-fd', '3', link]);
      expect(triples).toContainEqual(['--ro-bind-fd', '4', path.join(link, '.git')]);
      expect(triples.filter(([, src]) => [cwd, link, path.join(cwd, '.git')].includes(src))).toEqual([]);
      expect(opts.stdio).toHaveLength(5);
      const [workspaceFd, gitFd] = opts.stdio.slice(3);
      expect(Number.isInteger(workspaceFd) && Number.isInteger(gitFd)).toBe(true);
      expect(() => fs.fstatSync(workspaceFd)).toThrow(/EBADF/);
      expect(() => fs.fstatSync(gitFd)).toThrow(/EBADF/);
    });

    test('a folder that is not the checked realpath once opened refuses the turn, with nothing spawned or left open', async () => {
      const { impl, calls } = recorder();
      const opened = [];
      await expect(fdTurn(impl, cwd, {
        _fdPath: (fd) => { opened.push(fd); return decoy; },
      })).rejects.toThrow(/moved while it was being opened/);
      expect(calls).toHaveLength(0);
      expect(opened).toHaveLength(1);
      expect(() => fs.fstatSync(opened[0])).toThrow(/EBADF/);
    });

    test('a read-only workspace without a .git holds only the workspace, and keeps -try for the entry', async () => {
      fs.rmSync(path.join(cwd, '.git'), { recursive: true });
      const { impl, calls } = recorder();
      await fdTurn(impl, cwd, {
        environment: { model: 'test-model', sandbox: { mode: 'bwrap', trust: 'workspace', allow: [] } },
      });
      expect(calls).toHaveLength(1);
      const { args, opts } = calls[0];
      expect(bindTriples(args)).toContainEqual(['--ro-bind-fd', '3', cwd]);
      expect(args.flatMap((arg, i) => (arg === '--ro-bind-try' ? [[args[i + 1], args[i + 2]]] : [])))
        .toContainEqual([path.join(cwd, '.git'), path.join(cwd, '.git')]);
      expect(opts.stdio).toHaveLength(4);
      expect(() => fs.fstatSync(opts.stdio[3])).toThrow(/EBADF/);
    });

    // F494: the read-outside folder (only ~/.commonly/logs is admitted here) is
    // opened and checked like the workspace, and mounted from its descriptor.
    describe('and a read-outside logs folder', () => {
      let home;
      let logs;
      beforeEach(() => {
        home = path.join(root, 'home');
        logs = path.join(home, '.commonly', 'logs');
        fs.mkdirSync(logs, { recursive: true });
      });
      const readOutsideEnv = {
        model: 'test-model',
        sandbox: {
          mode: 'bwrap', trust: 'workspace', allow: ['write'], filesystem: { 'read-outside': ['~/.commonly/logs'] },
        },
      };
      const roBindTry = (args) => args.flatMap((arg, i) => (arg === '--ro-bind-try' ? [args[i + 1]] : []));

      test('mounts it from descriptor 5, after the workspace and its .git, and closes it after the spawn', async () => {
        const { impl, calls } = recorder();
        await fdTurn(impl, cwd, {
          environment: readOutsideEnv, _hostReadHome: home, _fdPath: (fd) => fdPathOf(fd, [logs]),
        });
        expect(calls).toHaveLength(1);
        const { args, opts } = calls[0];
        expect(bindTriples(args)).toContainEqual(['--ro-bind-fd', '5', logs]);
        expect(roBindTry(args)).not.toContain(logs);
        expect(args).toContain(`Read(/${logs}/**)`);
        expect(opts.stdio).toHaveLength(6);
        expect(() => fs.fstatSync(opts.stdio[5])).toThrow(/EBADF/);
      });

      test('a logs folder that is not the checked path once opened refuses the turn, with nothing left open', async () => {
        const { impl, calls } = recorder();
        const opened = [];
        await expect(fdTurn(impl, cwd, {
          environment: readOutsideEnv,
          _hostReadHome: home,
          _fdPath: (fd) => { opened.push(fd); return fdPathOf(fd); },
        })).rejects.toThrow(/moved while it was being opened/);
        expect(calls).toHaveLength(0);
        expect(opened).toHaveLength(3);
        for (const fd of opened) expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
      });

      test('a logs folder that does not exist binds nothing for it', async () => {
        fs.rmSync(logs, { recursive: true });
        const { impl, calls } = recorder();
        await fdTurn(impl, cwd, { environment: readOutsideEnv, _hostReadHome: home });
        expect(calls).toHaveLength(1);
        const { args, opts } = calls[0];
        // The seat's Read allow still names it: the list came from this home.
        expect(args).toContain(`Read(/${logs}/**)`);
        expect(args).not.toContain(logs);
        expect(opts.stdio).toHaveLength(5);
      });
    });

    test('a bwrap without descriptor binds keeps the path binds', async () => {
      const { impl, calls } = recorder();
      await turn(impl);
      expect(bindTriples(calls[0].args)).toContainEqual(['--bind', cwd, cwd]);
      expect(calls[0].opts.stdio).toHaveLength(3);
    });
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
