/**
 * The two facts a `workspace`-trust seat depends on (TASK-294), as pure
 * predicates so the attach path, the first-run bootstrap and the per-spawn
 * check all read them the same way.
 *
 * 1. Every pod the seat answers in is CONFIRMED private: not publicly
 *    readable, not listed, and invite-only. Visibility alone is not enough,
 *    because any agent can add itself to an open pod an agent created, listed
 *    or not. A pod whose fields the server did not report counts as public:
 *    the workspace tier lets the room read the start directory, so an unknown
 *    room fails closed.
 * 2. The start directory is a directory worth exposing to that room, and not
 *    one that contains the operator's whole account: `/`, `$HOME`, an ancestor
 *    of `$HOME`, or a directory inside one of the credential stores the public
 *    policy denies by name.
 */
import { realpathSync } from 'fs';
import { homedir } from 'os';
import {
  isAbsolute, join, relative, resolve,
} from 'path';

/** A pod is private only when the server says so in all three fields. */
export const podIsConfirmedPrivate = (pod) => (
  typeof pod?.publicRead === 'boolean'
  && typeof pod?.communityListed === 'boolean'
  && !pod.publicRead
  && !pod.communityListed
  && pod.joinPolicy === 'invite-only'
);

/** True only for a non-empty list in which every pod is confirmed private. */
export const allPodsConfirmedPrivate = (pods) => (
  Array.isArray(pods) && pods.length > 0 && pods.every(podIsConfirmedPrivate)
);

// The stores claude.js denies by absolute path for a public seat. A start
// directory inside one of them would put the seat's own credentials in reach.
const CREDENTIAL_DIRS = ['.commonly', '.claude', '.codex', '.ssh', '.aws', '.config'];

const realOrResolved = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const isInsideOrEqual = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Why `dir` cannot be a workspace seat's start directory, or `null` when it can.
 * Symlinks are resolved first, so a link to `$HOME` is refused as `$HOME`.
 */
export const workspaceStartDirRefusal = (dir, { home = homedir() } = {}) => {
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    return 'the start directory is not an absolute path';
  }
  const real = realOrResolved(dir);
  const realHome = realOrResolved(home);
  if (real === '/') return 'the start directory is /';
  if (isInsideOrEqual(realHome, real)) {
    return real === realHome
      ? 'the start directory is your home directory'
      : 'the start directory contains your home directory';
  }
  const store = CREDENTIAL_DIRS.find((name) => isInsideOrEqual(real, join(realHome, name)));
  if (store) return `the start directory is inside ~/${store}`;
  return null;
};

const PUBLIC_POD_REASON = 'a pod it answers in is publicly readable or open to join, or did not report whether it is';
// claude.js runs a workspace seat under Seatbelt on macOS and under bwrap on
// Linux (#2784). Native Windows has no sandbox for it, so there the default
// would be a seat that fails every turn rather than one that reads a project.
const UNSUPPORTED_OS_REASON = 'an agent works in its folder only on macOS and Linux for now';

/**
 * Where a first-run claude seat may read (TASK-294), from three facts the
 * bootstrap already holds: the adapter it detected, the rooms its token
 * answers in, and the directory the person ran it from. It returns the start
 * directory only when all three allow it, and otherwise the reason the seat
 * keeps the `public` default it had before, plus a `fix` when the person can
 * change the outcome by starting somewhere else. Any other adapter gets `null`:
 * `workspace` is claude-only for now, so there is nothing to decide.
 */
export const firstRunWorkspace = ({
  adapterName, installations, startDir, home, platform = process.platform,
} = {}) => {
  if (adapterName !== 'claude') return null;
  if (platform !== 'darwin' && platform !== 'linux') {
    return { workspacePath: null, reason: UNSUPPORTED_OS_REASON };
  }
  if (!allPodsConfirmedPrivate(installations)) {
    return { workspacePath: null, reason: PUBLIC_POD_REASON };
  }
  const refusal = workspaceStartDirRefusal(startDir, home === undefined ? {} : { home });
  if (refusal) {
    return {
      workspacePath: null,
      reason: refusal,
      fix: 'To let it read a project, run this command from that project\'s folder.',
    };
  }
  return { workspacePath: realOrResolved(startDir), reason: null };
};

/**
 * Where one turn of a seat runs, and under which trust. A pod can turn public
 * after attach, so a `workspace` seat's rooms are re-read before every turn
 * (`installations` is that read, or `null` when it failed). A turn that cannot
 * confirm them all private runs as a `public` seat in its scratch folder: the
 * confinement it would have had without the workspace. Any other trust runs
 * where and as it was started.
 */
export const workspaceTurnPlacement = ({
  environment, workspacePath, installations, scratchDir,
} = {}) => {
  const cwd = workspacePath || scratchDir;
  if (environment?.sandbox?.trust !== 'workspace' || allPodsConfirmedPrivate(installations)) {
    return { environment, cwd, reason: null };
  }
  // Its write/web grants widen the workspace tier only, so the public turn
  // drops them rather than carry them into a room strangers can read.
  const { allow: _grants, ...sandbox } = environment.sandbox;
  return {
    environment: { ...environment, sandbox: { ...sandbox, trust: 'public' } },
    cwd: scratchDir,
    reason: installations === null ? 'its pods could not be read' : PUBLIC_POD_REASON,
  };
};

export default {
  podIsConfirmedPrivate,
  allPodsConfirmedPrivate,
  workspaceStartDirRefusal,
  firstRunWorkspace,
  workspaceTurnPlacement,
};
