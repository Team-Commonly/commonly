// Which local files commonly_attach_file may read and upload into a pod.
//
// The tool reads a path the model chooses, so the path is confined:
// - the working directory the server was started in, unless that is the home
//   folder or the filesystem root (too broad to count as a workspace);
// - any folder named in COMMONLY_ATTACH_ROOTS (path-delimiter separated).
// Inside those folders, hidden files and anything in a hidden folder (a path
// part starting with ".") and key-shaped file names are still refused.
// Symlinks are resolved first, so a link inside a root that points outside it,
// or at a hidden file, is refused too.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  delimiter, isAbsolute, parse, relative, resolve, sep,
} from 'node:path';

const KEY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore|kdbx))$/i;

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const allowedRoots = ({ cwd, env, home }) => {
  const roots = [];
  const cwdReal = real(cwd);
  const homeReal = real(home) || home;
  if (cwdReal && cwdReal !== homeReal && cwdReal !== parse(cwdReal).root) roots.push(cwdReal);
  for (const entry of String(env.COMMONLY_ATTACH_ROOTS || '').split(delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed || !isAbsolute(trimmed)) continue;
    const rootReal = real(trimmed);
    if (rootReal && rootReal !== parse(rootReal).root) roots.push(rootReal);
  }
  return roots;
};

/**
 * Resolve `filePath` (relative to `cwd`) to the real path to read, or throw an
 * Error whose message tells the model what to do instead.
 */
export function resolveAttachPath(filePath, {
  cwd = process.cwd(), env = process.env, home = homedir(),
} = {}) {
  const asked = resolve(cwd, String(filePath || ''));
  const target = real(asked);
  if (!target) throw new Error(`There is no file at ${filePath}.`);
  const roots = allowedRoots({ cwd, env, home });
  const root = roots.find((r) => inside(r, target));
  if (!root) {
    const where = roots.length ? roots.join(', ') : 'none: the server was started in the home folder or the filesystem root';
    throw new Error(
      `${filePath} is outside the folders commonly_attach_file may read (${where}). `
      + 'Write or copy the file into the working directory, or add its folder to COMMONLY_ATTACH_ROOTS.',
    );
  }
  const parts = relative(root, target).split(sep).filter(Boolean);
  if (parts.some((part) => part.startsWith('.'))) {
    throw new Error(`${filePath} is a hidden file or inside a hidden folder; commonly_attach_file does not attach those.`);
  }
  if (KEY_NAME.test(parts[parts.length - 1] || '')) {
    throw new Error(`${filePath} looks like a key or certificate file; commonly_attach_file does not attach those.`);
  }
  return target;
}
