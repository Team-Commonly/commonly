/**
 * bind-fd.test.mjs — F211: a bwrap bind source held by an open descriptor.
 *
 * `/proc/self/fd/N` is Linux's; elsewhere the tests pass the path the kernel
 * would report, found by inode, so the open and the check run for real.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { BIND_SOURCE_MOVED, closeHeldPaths, openHeldPath } from '../src/lib/sandbox/bind-fd.js';

const onLinux = process.platform === 'linux';

describe('openHeldPath', () => {
  let root;
  let folder;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bind-fd-')));
    folder = path.join(root, 'project');
    fs.mkdirSync(folder);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const byInode = (candidates) => (fd) => {
    const { ino, dev } = fs.fstatSync(fd);
    return candidates.find((p) => { const st = fs.statSync(p); return st.ino === ino && st.dev === dev; }) || '/elsewhere';
  };
  const fdPath = onLinux ? undefined : (fd) => byInode([folder])(fd);

  test('returns an open descriptor on the folder that was checked', () => {
    const fd = openHeldPath(folder, { directory: true, ...(fdPath ? { fdPath } : {}) });
    try {
      expect(fs.fstatSync(fd).ino).toBe(fs.statSync(folder).ino);
    } finally {
      closeHeldPaths([fd]);
    }
  });

  // A parent folder swapped for a link is followed by the open, and the
  // descriptor then names somewhere else.
  test('refuses a descriptor that names another path, and closes it', () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'inner'), { recursive: true });
    const link = path.join(root, 'via-link');
    fs.symlinkSync(elsewhere, link);
    const target = path.join(link, 'inner');
    let opened;
    const reported = (fd) => {
      opened = fd;
      return onLinux ? fs.readlinkSync(`/proc/self/fd/${fd}`) : path.join(elsewhere, 'inner');
    };
    expect(() => openHeldPath(target, { directory: true, fdPath: reported }))
      .toThrow(expect.objectContaining({ code: BIND_SOURCE_MOVED }));
    expect(() => fs.fstatSync(opened)).toThrow(/EBADF/);
  });

  test('never opens through a link at the last component', () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(folder, link);
    // Linux reports ELOOP; macOS, with O_DIRECTORY also set, ENOTDIR. Either refuses.
    let code;
    try { openHeldPath(link, { directory: true, fdPath: () => folder }); } catch (error) { code = error.code; }
    expect(['ELOOP', 'ENOTDIR']).toContain(code);
    expect(() => openHeldPath(link, { fdPath: () => folder })).toThrow(expect.objectContaining({ code: 'ELOOP' }));
  });

  test('a missing path throws ENOENT with nothing open', () => {
    expect(() => openHeldPath(path.join(root, 'missing'), { fdPath: () => '' }))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  test('closeHeldPaths tolerates a descriptor already closed', () => {
    const fd = fs.openSync(folder, 'r');
    fs.closeSync(fd);
    expect(() => closeHeldPaths([fd])).not.toThrow();
  });
});
