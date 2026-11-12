/**
 * F185. Every public OpenCode spawn holds a live Commonly token and a
 * provider-proxy token in its per-spawn folder, so every one gets the same
 * pre-spawn link walk: from the worktree root, node_modules, .venv and .git
 * links-only, every link held to the worktree, and a walk its bound stopped
 * refuses. A link to a regular file outside every folder holding this spawn's
 * secrets (the per-spawn folder, the seat's data home) leads nowhere else, and
 * passes; anything resolving into those folders is refused, in any spelling.
 */
import { execFileSync } from 'child_process';
import { closeSync, existsSync, openSync } from 'fs';
import {
  mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertSpawnRootOutsideWorkspace } from '../src/lib/adapters/opencode.js';

let root;
let tempRoot;
let spawnRoot;
let seatHome;
let ws;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'opencode-f185-')));
  tempRoot = join(root, 'temp-root');
  spawnRoot = join(tempRoot, 'commonly-opencode-abc');
  seatHome = join(root, 'opencode-homes', 'seat');
  ws = join(root, 'ws');
  await mkdir(spawnRoot, { recursive: true });
  await mkdir(seatHome, { recursive: true });
  await mkdir(ws, { recursive: true });
  await writeFile(join(spawnRoot, 'credential.json'), '{}', { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const check = (workspace = ws, options = {}) => assertSpawnRootOutsideWorkspace(workspace, spawnRoot, {
  secretRoots: [seatHome], ...options,
});

const venv = async (dir) => {
  await mkdir(join(dir, '.venv', 'bin'), { recursive: true });
  await mkdir(join(dir, '.venv', 'lib', 'python3.12', 'site-packages', 'pkg'), { recursive: true });
  await writeFile(join(dir, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  await symlink(process.execPath, join(dir, '.venv', 'bin', 'python'));
  for (let i = 0; i < 40; i += 1) {
    await writeFile(join(dir, '.venv', 'lib', 'python3.12', 'site-packages', 'pkg', `m${i}.py`), '');
  }
};

describe('every public spawn is walked the same way', () => {
  test('a deep node_modules link to the temp directory is refused', async () => {
    await mkdir(join(ws, 'node_modules', 'x', 'dist'), { recursive: true });
    await symlink(tempRoot, join(ws, 'node_modules', 'x', 'dist', 'cache'));
    expect(() => check()).toThrow(/symlink .*node_modules\/x\/dist\/cache.* reaches the per-spawn/);
  });

  test('a file link to the credential file is refused', async () => {
    await mkdir(join(ws, 'src'), { recursive: true });
    await symlink(join(spawnRoot, 'credential.json'), join(ws, 'src', 'notes'));
    expect(() => check()).toThrow(/symlink .*src\/notes.* reaches the per-spawn/);
  });

  test('a link into the seat\'s data home is refused, file or folder', async () => {
    await writeFile(join(seatHome, 'state.json'), '{}');
    await mkdir(join(ws, 'src'), { recursive: true });
    await symlink(join(seatHome, 'state.json'), join(ws, 'src', 'a'));
    expect(() => check()).toThrow(/symlink .*src\/a.* reaches the seat's data folder/);
    await rm(join(ws, 'src', 'a'));
    await symlink(join(root, 'opencode-homes'), join(ws, 'src', 'b'));
    expect(() => check()).toThrow(/symlink .*src\/b.* reaches the seat's data folder/);
  });

  test('a dangling link is judged by where it would land: into the data folder refused, elsewhere not', async () => {
    await mkdir(join(ws, 'src'), { recursive: true });
    await symlink(join(seatHome, 'state', 'later.db'), join(ws, 'src', 'a'));
    expect(() => check()).toThrow(/symlink .*src\/a.* reaches the seat's data folder/);
    // `..` after a folder link applies to where that link really goes.
    await rm(join(ws, 'src', 'a'));
    await mkdir(join(seatHome, 'data'), { recursive: true });
    await mkdir(join(root, 'outside'), { recursive: true });
    await symlink(join(seatHome, 'data'), join(root, 'outside', 'sym'));
    // Written by hand: path.join would fold the .. away before the link exists.
    await symlink(`${join(root, 'outside', 'sym')}/../new`, join(ws, 'src', 'a'));
    expect(() => check()).toThrow(/symlink .*src\/a.* reaches the seat's data folder/);
    // Reverse: a spawn folder from an earlier turn, since removed, is no route.
    await rm(join(ws, 'src', 'a'));
    await symlink(join(tempRoot, 'commonly-opencode-old'), join(ws, 'src', 'a'));
    expect(() => check()).not.toThrow();
  });

  test('a link into /dev or /proc is refused, however it is reached', async () => {
    await mkdir(join(ws, 'src'), { recursive: true });
    await mkdir(join(root, 'outside'), { recursive: true });
    await symlink('/dev', join(root, 'outside', 'p'));
    const targets = ['/dev/fd/9', join(root, 'outside', 'p', 'fd', '9')];
    if (process.platform === 'linux') targets.push('/proc/self/fd/9', '/proc/self/root');
    for (const target of targets) {
      await symlink(target, join(ws, 'src', 'x'));
      expect(() => check()).toThrow(/symlink .*src\/x.* leads into \/proc or \/dev/);
      await rm(join(ws, 'src', 'x'));
    }
    // A descriptor this process holds open on a regular file outside: the
    // path resolves here, to a file the relief would pass, and still refuses.
    await writeFile(join(root, 'outside', 'held.txt'), 'x');
    const fd = openSync(join(root, 'outside', 'held.txt'), 'r');
    try {
      const held = [`/dev/fd/${fd}`];
      if (process.platform === 'linux') held.push(`/proc/self/fd/${fd}`);
      for (const target of held) {
        await symlink(target, join(ws, 'src', 'x'));
        expect(() => check()).toThrow(/symlink .*src\/x.* leads into \/proc or \/dev/);
        await rm(join(ws, 'src', 'x'));
      }
    } finally {
      closeSync(fd);
    }
    // And through a second link inside the workspace.
    await symlink('/dev/fd/9', join(ws, 'src', 'y'));
    await symlink('y', join(ws, 'src', 'x'));
    expect(() => check()).toThrow(/symlink .*src\/[xy].* leads into \/proc or \/dev/);
  });

  test('a link spelled through the firmlink, or in other case, is the same place', async () => {
    await mkdir(join(ws, 'src'), { recursive: true });
    const spellings = [join('/System/Volumes/Data', spawnRoot), spawnRoot.toUpperCase()]
      .filter((path) => path !== spawnRoot && existsSync(path));
    // Both exist on a stock Mac; elsewhere this case has nothing to spell.
    if (process.platform === 'darwin') expect(spellings.length).toBeGreaterThan(0);
    for (const spelling of spellings) {
      await symlink(spelling, join(ws, 'src', 'alias'));
      expect(() => check()).toThrow(/symlink .*src\/alias.* reaches the per-spawn/);
      await rm(join(ws, 'src', 'alias'));
    }
  });

  test('a walk its bound stopped is refused', async () => {
    await mkdir(join(ws, 'src'), { recursive: true });
    for (let i = 0; i < 20; i += 1) await writeFile(join(ws, 'src', `f${i}.js`), '');
    expect(() => check(ws, { bounds: { maxDepth: 32, maxEntries: 10 } })).toThrow(/stopped at its entry bound/);
    expect(() => check()).not.toThrow();
  });

  test('a link to a folder outside the worktree is refused: the walk cannot vouch for a tree it never read', async () => {
    await mkdir(join(root, 'outside'), { recursive: true });
    await mkdir(join(ws, 'src'), { recursive: true });
    await symlink(join(root, 'outside'), join(ws, 'src', 'vendor'));
    expect(() => check()).toThrow(/symlink .*src\/vendor.* leads outside/);
  });
});

describe('what still runs', () => {
  test('a virtualenv: its interpreter link to a file outside passes, and its files do not spend the source budget', async () => {
    await venv(ws);
    expect(() => check(ws, { bounds: { maxDepth: 32, maxEntries: 10 } })).not.toThrow();
  });

  test('a Python environment under another name, or a conda one, is walked as a dependency tree', async () => {
    await venv(ws);
    await mkdir(join(ws, 'tools'), { recursive: true });
    await rename(join(ws, '.venv'), join(ws, 'tools', 'env'));
    await mkdir(join(ws, 'conda', 'conda-meta'), { recursive: true });
    for (let i = 0; i < 40; i += 1) await writeFile(join(ws, 'conda', 'conda-meta', `p${i}.json`), '{}');
    expect(() => check(ws, { bounds: { maxDepth: 32, maxEntries: 10 } })).not.toThrow();
    await symlink(tempRoot, join(ws, 'conda', 'conda-meta', 'cache'));
    expect(() => check()).toThrow(/symlink .*conda-meta\/cache.* reaches the per-spawn/);
  });

  test('a deep link in the virtualenv that reaches the per-spawn folder is still refused', async () => {
    await venv(ws);
    await symlink(tempRoot, join(ws, '.venv', 'lib', 'python3.12', 'site-packages', 'pkg', 'cache'));
    expect(() => check()).toThrow(/symlink .*\.venv.*pkg\/cache.* reaches the per-spawn/);
  });

  test('a dependency link to a file outside the worktree passes; to a folder outside it does not', async () => {
    await mkdir(join(ws, 'node_modules', 'x'), { recursive: true });
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'outside', 'tool'), '#!/bin/sh\n');
    await symlink(join(root, 'outside', 'tool'), join(ws, 'node_modules', 'x', 'tool'));
    expect(() => check()).not.toThrow();
    await symlink(join(root, 'outside'), join(ws, 'node_modules', 'x', 'dir'));
    expect(() => check()).toThrow(/symlink .*node_modules\/x\/dir.* leads outside/);
  });
});

describe('the walk starts at the worktree root', () => {
  test('a seat in a subfolder is refused for a sibling package\'s link to the temp directory', async () => {
    const repo = join(root, 'repo');
    await mkdir(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    const seat = join(repo, 'apps', 'seat');
    await mkdir(seat, { recursive: true });
    await mkdir(join(repo, 'packages', 'other'), { recursive: true });
    await symlink(tempRoot, join(repo, 'packages', 'other', 'cache'));
    expect(() => check(seat)).toThrow(/symlink .*packages\/other\/cache.* reaches the per-spawn/);
    // Reverse: the same link pointing inside the repository runs.
    await rm(join(repo, 'packages', 'other', 'cache'));
    await symlink(join(repo, 'apps'), join(repo, 'packages', 'other', 'cache'));
    expect(() => check(seat)).not.toThrow();
  });
});
