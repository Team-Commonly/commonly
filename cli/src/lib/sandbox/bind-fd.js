/**
 * A bind source held by an open descriptor (F211).
 *
 * bwrap resolves a path bind's source when the jail starts, after the host
 * checked it. A seat whose workspace sits inside another writable workspace
 * can have a folder on that path swapped for a link in the window, and the
 * jail is then bound onto the link's target (CodeRabbit on #3527).
 * `--bind-fd` and `--ro-bind-fd` (bubblewrap 0.10.0, backported to 0.6.3)
 * mount an already-open descriptor instead. bwrap also checks that the mount
 * landed on that descriptor's inode, and closes the descriptor before the
 * child runs, so the jail never holds a handle to a host folder.
 *
 * Opening a path still follows links in its parent folders, so the
 * descriptor is checked after the open: the path the kernel reports for it
 * must be the expected realpath. A swap before the open is refused. A swap
 * after it no longer moves anything: the descriptor names the folder that
 * was checked.
 *
 * Linux only, like bwrap. `/proc/self/fd/N` names the open file.
 */

import { closeSync, constants, openSync, readlinkSync } from 'fs';

export const BIND_SOURCE_MOVED = 'bind_source_moved';

const procFdPath = (fd) => readlinkSync(`/proc/self/fd/${fd}`);

/**
 * Open `path` (the last component never a link) and confirm the descriptor
 * names exactly `path`. Returns the descriptor; the caller closes it once the
 * child has it. Throws the open's own error (ENOENT, ELOOP, ENOTDIR) or a
 * `bind_source_moved` error, with nothing left open.
 */
export const openHeldPath = (path, {
  directory = false,
  open = openSync,
  close = closeSync,
  fdPath = procFdPath,
} = {}) => {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0);
  const fd = open(path, flags);
  try {
    const actual = fdPath(fd);
    if (actual !== path) {
      throw Object.assign(
        new Error(`refusing a workspace turn: ${path} moved while it was being opened for the sandbox`),
        { code: BIND_SOURCE_MOVED },
      );
    }
    return fd;
  } catch (error) {
    close(fd);
    throw error;
  }
};

/** Close every descriptor, ignoring one already closed. */
export const closeHeldPaths = (fds = [], close = closeSync) => {
  for (const fd of fds) {
    try { close(fd); } catch { /* already closed */ }
  }
};
