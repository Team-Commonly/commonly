/**
 * Host-side file operations under a microVM seat HOME (microsandbox.js).
 *
 * The seat HOME is mounted writable into the guest, and kept on the host
 * between turns. So anything in it may be what a previous turn left: a
 * symbolic link or a Windows junction in place of a folder or a file, pointing
 * anywhere on this computer. Every host write, removal, folder creation and
 * read below the HOME goes through here, and none of them follows a link:
 *
 *   - each path component from the HOME down is lstat'ed and must be a real
 *     folder (or file); a link is refused, never followed, never removed;
 *   - missing folders are made one level at a time, under a parent just checked;
 *   - a file is written to a staged name drawn at random and created
 *     exclusively (O_CREAT|O_EXCL, plus O_NOFOLLOW where the platform has it),
 *     then renamed over the target, which replaces the entry itself;
 *   - a read opens with O_NOFOLLOW where the platform has it, checks the handle
 *     is a file, and reads at most a cap.
 *
 * Node's lstat reports a Windows junction as a symbolic link, so the same check
 * covers both. A refusal names the path; the person removes the link (not what
 * it points to) and the turn runs again. `io` is a test seam.
 *
 * These run while no VM of the seat runs: before the turn boots, and after msb
 * has exited. That is what makes check-then-act sound here.
 */
import { randomBytes } from 'crypto';
import { constants } from 'fs';
import {
  lstat, mkdir, open, readdir, rename, rmdir, unlink,
} from 'fs/promises';
import { basename, join } from 'path';

const NOFOLLOW = constants.O_NOFOLLOW || 0;
const DIRECTORY = constants.O_DIRECTORY || 0;

const defaultIo = {
  lstat, mkdir, open, readdir, rename, rmdir, unlink,
};

export const GUEST_PATH_REFUSED = 'guest_path_refused';

const refuse = (path, what) => Object.assign(new Error(
  `refusing to touch ${path} in the microVM seat home: it should be ${what} and is a link or something else. `
  + 'A turn can write its seat home; remove that entry (the link itself, not what it points to) and run the turn again.',
), { code: GUEST_PATH_REFUSED });

const lstatOrNull = async (io, path) => {
  try {
    return await io.lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

const plainName = (name) => {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || basename(name) !== name || /[\\/]/.test(name)) {
    throw new Error(`not a plain name under the microVM seat home: ${JSON.stringify(name)}`);
  }
  return name;
};

/**
 * `root`, then each of `parts` under it, as real folders (made 0700 when
 * missing). The parent of `root` must exist and is not the guest's. Returns
 * the deepest folder's path.
 */
export const ensureGuestDir = async (root, parts = [], { io = defaultIo } = {}) => {
  let current = root;
  for (const part of [null, ...parts]) {
    if (part !== null) current = join(current, plainName(part));
    // eslint-disable-next-line no-await-in-loop
    let info = await lstatOrNull(io, current);
    if (!info) {
      // eslint-disable-next-line no-await-in-loop
      await io.mkdir(current, { mode: 0o700 });
      // eslint-disable-next-line no-await-in-loop
      info = await io.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw refuse(current, 'a folder');
  }
  if (NOFOLLOW && DIRECTORY) {
    let handle;
    try {
      handle = await io.open(current, constants.O_RDONLY | NOFOLLOW | DIRECTORY);
    } catch (err) {
      if (['ELOOP', 'ENOTDIR', 'ENOENT'].includes(err?.code)) throw refuse(current, 'a folder');
      throw err;
    }
    await handle.close();
  }
  return current;
};

// Removes a real folder's contents and the folder, refusing any link inside.
const removeTree = async (io, path) => {
  for (const name of await io.readdir(path)) {
    const child = join(path, name);
    // eslint-disable-next-line no-await-in-loop
    const info = await io.lstat(child);
    if (info.isSymbolicLink()) throw refuse(child, 'a file or folder');
    // eslint-disable-next-line no-await-in-loop
    if (info.isDirectory()) await removeTree(io, child);
    // eslint-disable-next-line no-await-in-loop
    else await io.unlink(child);
  }
  await io.rmdir(path);
};

/** Removes `dir/name` (a file, or a folder and all it holds). A link anywhere is refused. */
export const removeGuestEntry = async (dir, name, { io = defaultIo } = {}) => {
  const path = join(dir, plainName(name));
  const info = await lstatOrNull(io, path);
  if (!info) return false;
  if (info.isSymbolicLink()) throw refuse(path, 'a file or folder');
  if (info.isDirectory()) await removeTree(io, path);
  else await io.unlink(path);
  return true;
};

/** Writes `dir/name` through a random, exclusively created staged file. */
export const writeGuestFile = async (dir, name, text, { io = defaultIo } = {}) => {
  const target = join(dir, plainName(name));
  const existing = await lstatOrNull(io, target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw refuse(target, 'a file');
  const staged = join(dir, `.${name}.${randomBytes(12).toString('hex')}.tmp`);
  const handle = await io.open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await io.rename(staged, target);
  } catch (err) {
    await io.unlink(staged).catch(() => {});
    throw err;
  }
};

/**
 * Reads `dir/name` as text, at most `maxBytes` of it. Missing reads as null.
 * Returns { text, truncated }.
 */
export const readGuestFile = async (dir, name, { maxBytes, io = defaultIo } = {}) => {
  const path = join(dir, plainName(name));
  const info = await lstatOrNull(io, path);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw refuse(path, 'a file');
  let handle;
  try {
    handle = await io.open(path, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ELOOP') throw refuse(path, 'a file');
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) throw refuse(path, 'a file');
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    const truncated = filled > maxBytes;
    return { text: buffer.subarray(0, Math.min(filled, maxBytes)).toString('utf8'), truncated };
  } finally {
    await handle.close();
  }
};

export default {
  ensureGuestDir, readGuestFile, removeGuestEntry, writeGuestFile,
};
