/**
 * bwrap.bind-fd.smoke.test.mjs — F211, run for real on Linux.
 *
 * A seat's workspace nested inside another writable workspace: the outer seat
 * swaps the inner folder for a link in the window between the host's check
 * and bwrap's mount. With a path bind the jail is mounted on the link's
 * target. With a descriptor bind it is mounted on the folder that was
 * checked, and the jail holds no handle to a host folder.
 *
 * Runs only where bwrap binds descriptors (bubblewrap 0.10.0+, or 0.6.3).
 * COMMONLY_REQUIRE_BWRAP_BIND_FD=1 turns "not available" into a failure, as
 * the Linux workflow sets.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectBwrap, wrapArgvWithBwrap } from '../src/lib/sandbox/bwrap.js';
import { closeHeldPaths, openHeldPath } from '../src/lib/sandbox/bind-fd.js';

const required = process.env.COMMONLY_REQUIRE_BWRAP_BIND_FD === '1';
const bwrap = process.platform === 'linux' ? detectBwrap() : { available: false };
const runs = bwrap.available && bwrap.bindFd === true;
const maybe = runs ? test : test.skip;

test('bwrap binds descriptors here, where this smoke is required', () => {
  // The whole probe result, reason included, is in the failure diff.
  if (required) expect({ platform: process.platform, ...bwrap }).toEqual(expect.objectContaining({ available: true, bindFd: true }));
  if (required && !runs) {
    // eslint-disable-next-line no-console
    console.log('bwrap probe', JSON.stringify(bwrap));
  }
});

describe('a workspace swapped for a link after the check', () => {
  let root;
  let inner;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bind-fd-smoke-')));
    inner = path.join(root, 'outer', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'marker'), 'checked folder\n');
    fs.mkdirSync(path.join(root, 'secret'));
    fs.writeFileSync(path.join(root, 'secret', 'marker'), 'link target\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // The outer seat's move, made between the check and the jail's start.
  const swap = () => {
    fs.renameSync(inner, path.join(root, 'outer', 'inner-moved'));
    fs.symlinkSync(path.join(root, 'secret'), inner);
  };
  const jail = (command, opts, stdio = []) => {
    const argv = wrapArgvWithBwrap(command, {}, { workspacePath: inner, workspaceSource: inner, ...opts });
    return spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', ...stdio] });
  };

  maybe('a path bind follows the link: the window this closes', () => {
    swap();
    const res = jail(['cat', 'marker'], { workspaceReadOnly: true });
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('link target\n');
  });

  maybe('a descriptor bind mounts the folder that was checked', () => {
    const fd = openHeldPath(inner, { directory: true });
    try {
      swap();
      const res = jail(['cat', 'marker'], { workspaceReadOnly: true, bindFds: { workspace: 3 } }, [fd]);
      expect(res.stderr).toBe('');
      expect(res.stdout).toBe('checked folder\n');
    } finally {
      closeHeldPaths([fd]);
    }
  });

  // openat(fd, "..") from inside would reach the host, so bwrap must close it.
  maybe('the jail holds no descriptor to the host folder', () => {
    const fd = openHeldPath(inner, { directory: true });
    try {
      const res = jail(['sh', '-c', 'if [ -e /proc/$$/fd/3 ]; then echo held; else echo none; fi'], {
        workspaceReadOnly: true, bindFds: { workspace: 3 },
      }, [fd]);
      expect(res.stdout.trim().split('\n').pop()).toBe('none');
    } finally {
      closeHeldPaths([fd]);
    }
  });

  // A worktree's .git is a file naming its gitdir; it is held the same way.
  maybe('a file entry is mounted read-only from its descriptor', () => {
    fs.writeFileSync(path.join(inner, '.git'), 'gitdir: /elsewhere\n');
    const ws = openHeldPath(inner, { directory: true });
    const entry = openHeldPath(path.join(inner, '.git'));
    try {
      const res = jail(['sh', '-c', 'cat .git; echo x >> .git && echo wrote || echo refused'], {
        readOnlyWorkspaceEntries: ['.git'], bindFds: { workspace: 3, entries: { '.git': 4 } },
      }, [ws, entry]);
      expect(res.stdout).toBe('gitdir: /elsewhere\nrefused\n');
    } finally {
      closeHeldPaths([ws, entry]);
    }
  });

  maybe('a swap before the open is refused', () => {
    swap();
    expect(() => openHeldPath(path.join(root, 'outer', 'inner-moved', '..', 'inner'), { directory: true }))
      .toThrow();
    const viaParent = path.join(root, 'via');
    fs.symlinkSync(path.join(root, 'outer'), viaParent);
    expect(() => openHeldPath(path.join(viaParent, 'inner-moved'), { directory: true }))
      .toThrow(expect.objectContaining({ code: 'bind_source_moved' }));
  });
});
