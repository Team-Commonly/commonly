/**
 * Process groups for supervised children.
 *
 * An agent CLI spawns its own children: MCP servers through `npx`, a native
 * binary behind a node launcher, shells for tools. Killing only the CLI leaves
 * those running, holding the run's work and keys on a shared host. A child the
 * supervisor will kill is therefore started as the leader of its own process
 * group, and killed as a group.
 *
 * Leading a group is never inferred. The spawner that passed `detached` marks
 * the child, and only a marked child that is still alive is ever signalled by
 * negative pid: signalling `-pid` for a process that does not lead its group
 * can reach an unrelated group.
 *
 * A child in its own group is outside the wrapper's group, so launchd's kill
 * of the seat's group on exit no longer reaches it. `trackSupervisedGroup`
 * covers that: while any tracked group is live, the wrapper kills them all
 * when it receives SIGTERM, SIGINT or SIGHUP, and when it exits.
 */

/** Set on a child by the code that spawned it with `detached: true`. */
export const LEADS_PROCESS_GROUP = Symbol.for('@commonlyai/seats.leadsProcessGroup');

/** Whether a child can lead its own group here (POSIX only). */
export const PROCESS_GROUPS_SUPPORTED = process.platform !== 'win32';

/**
 * The ctx key the supervisor sets to tell an adapter it will kill the child's
 * group, so the adapter may start the child in one. Unset, an adapter spawns
 * exactly as it would unsupervised.
 */
export const OWN_PROCESS_GROUP = 'ownProcessGroup';

export const wantsOwnProcessGroup = (ctx) => ctx?.[OWN_PROCESS_GROUP] === true && PROCESS_GROUPS_SUPPORTED;

/**
 * Spawn through `spawnImpl`. With `ownGroup`, the child is started detached
 * (it calls setsid, so it leads a new group whose id is its pid) and marked.
 * Without it, `options` reach `spawnImpl` untouched.
 */
export const spawnInOwnGroup = (spawnImpl, command, args, options, { ownGroup = false } = {}) => {
  if (!ownGroup || !PROCESS_GROUPS_SUPPORTED) return spawnImpl(command, args, options);
  const child = spawnImpl(command, args, { ...options, detached: true });
  if (child && typeof child === 'object') child[LEADS_PROCESS_GROUP] = true;
  return child;
};

const isAlive = (child) => child.exitCode === null && child.signalCode === null;

/**
 * True only for a child its spawner marked, with a real pid, that has not been
 * reaped. Node sets exitCode/signalCode in the same tick it reaps, so while
 * this holds the pid (and so the group id) cannot have been reused.
 */
export const leadsOwnGroup = (child) => !!child
  && child[LEADS_PROCESS_GROUP] === true
  && Number.isInteger(child.pid) && child.pid > 0
  && isAlive(child);

/**
 * Kill a child, and its whole group when it leads one. Falls back to
 * `child.kill` when the child does not lead a group, or the group signal fails.
 * Returns whether a signal was delivered.
 */
export const killProcessTree = (child, signal = 'SIGKILL') => {
  if (leadsOwnGroup(child)) {
    try { process.kill(-child.pid, signal); return true; } catch { /* fall back to the leader */ }
  }
  try { return child.kill(signal) !== false; } catch { return false; }
};

// ── Wrapper-exit cleanup ────────────────────────────────────────────────────

const EXIT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const tracked = new Set();
const handlers = new Map();
let onExit = null;

/** SIGKILL every tracked group still led by a live child. Synchronous. */
export const killSupervisedGroups = (signal = 'SIGKILL') => {
  let killed = 0;
  for (const child of tracked) {
    if (!leadsOwnGroup(child)) continue;
    try { process.kill(-child.pid, signal); killed += 1; } catch { /* already gone */ }
  }
  return killed;
};

const uninstall = () => {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  handlers.clear();
  if (onExit) process.removeListener('exit', onExit);
  onExit = null;
};

const install = () => {
  if (onExit) return;
  onExit = () => { killSupervisedGroups(); };
  process.on('exit', onExit);
  for (const signal of EXIT_SIGNALS) {
    const handler = () => {
      killSupervisedGroups();
      // Listening for a signal replaces its default action. When nothing else
      // handles it, restore that action and re-raise, so the wrapper still
      // terminates exactly as it would have without this module.
      if (process.listenerCount(signal) === 1) {
        uninstall();
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
};

const untrack = (child) => {
  tracked.delete(child);
  if (tracked.size === 0) uninstall();
};

/**
 * Track a group-leading child until it exits. The handlers exist only while a
 * tracked child is live, so a wrapper with no supervised group in flight keeps
 * its signal behaviour unchanged. A child that does not lead a group is
 * ignored: launchd's group kill already reaches it.
 */
export const trackSupervisedGroup = (child) => {
  if (!leadsOwnGroup(child) || tracked.has(child)) return false;
  tracked.add(child);
  install();
  child.once?.('exit', () => untrack(child));
  return true;
};

/** For tests: how many groups are tracked. */
export const trackedGroupCount = () => tracked.size;
