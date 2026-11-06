/**
 * The folder an adapter keeps one turn's credential in sits under the temp
 * root. The sandbox denies that root by leaving it out of every grant, so a
 * workspace that holds it undoes the denial: the workspace grant covers it,
 * and code in the jail can read the credential and replace the turn's files
 * (F219; measured on a real `codex sandbox`, where a workspace of $TMPDIR read
 * the credential and a project folder could not).
 *
 * Checked before the folder exists, against the root, so a refused turn writes
 * nothing. OpenCode has its own check, which also walks links and git worktrees.
 */
import { realpath } from 'fs/promises';
import { tmpdir } from 'os';
import {
  basename, dirname, join, resolve, sep,
} from 'path';

export const contains = (outer, inner) => inner === outer
  || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

// The real path of a path that may not exist yet: its nearest existing
// ancestor resolved, with the rest appended. realpath(3) also returns the
// disk's own spelling, which matters on a volume that folds case.
export const realpathOfNearest = async (path) => {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (err) {
      // Only a missing path walks up. Anything else (EACCES, ELOOP) would leave
      // the containment check comparing a path nobody resolved: fail closed.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
};

/** Throws when `workspace` holds the temp root; returns its real path otherwise. */
export const refuseWorkspaceHoldingTurnDirs = async ({
  workspace, seat, tempRoot = tmpdir(),
}) => {
  const [realWorkspace, realRoot] = await Promise.all([
    realpathOfNearest(workspace || process.cwd()),
    realpathOfNearest(tempRoot),
  ]);
  if (contains(realWorkspace, realRoot)) {
    throw new Error(`${seat} cannot run in ${workspace || process.cwd()}: it contains the temp folder (${tempRoot}) `
      + 'where each turn keeps the agent\'s credential, which the sandbox would then expose. '
      + 'Run it in a project folder, or set TMPDIR outside it.');
  }
  return realWorkspace;
};
