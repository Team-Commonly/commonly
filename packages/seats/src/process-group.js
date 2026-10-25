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
 * A group kill misses a descendant that moved to a group of its own (codex
 * starts every MCP server and tool command that way; claude's Bash tool does
 * too). So before any signal, the kill also snapshots the process table and
 * walks the child's descendants, deepest first. Each pid is re-read right
 * before it is signalled and killed only if its parent and start time still
 * match the snapshot: a pid that exited and was reused by another process on
 * this host is left alone. Leaves go first so a pid's parent is still alive,
 * and its ppid still meaningful, when it is checked.
 *
 * A child in its own group is outside the wrapper's group, so launchd's kill
 * of the seat's group on exit no longer reaches it. `trackSupervisedGroup`
 * covers that: while any tracked group is live, the wrapper kills them all
 * when it exits, and on SIGTERM, SIGINT or SIGHUP when nothing else handles
 * the signal. A host that handles the signal itself (`agent run` finishes the
 * in-flight turn on SIGTERM) owns the timing: it calls
 * `armSupervisedGroupDeadline` so the groups die before launchd's SIGKILL,
 * which no handler can catch, and the exit hook covers the clean case.
 */

import { spawnSync } from 'node:child_process';

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

// ── The process table ──────────────────────────────────────────────────────

const PS_ENV = { ...process.env, LC_ALL: 'C' };

const parseTable = (text) => {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] });
  }
  return rows;
};

const ps = (args) => {
  try {
    const out = spawnSync('ps', args, { encoding: 'utf8', env: PS_ENV, timeout: 5000 });
    return out.error ? null : parseTable(out.stdout);
  } catch { return null; }
};

/** Every process: { pid, ppid, started }. null when ps is unavailable. */
export const readProcessTable = () => ps(['-A', '-o', 'pid=,ppid=,lstart=']);

/** One process as it is now, or null when it is gone. */
export const readProcess = (pid) => (ps(['-o', 'pid=,ppid=,lstart=', '-p', String(pid)]) || [])
  .find((row) => row.pid === pid) || null;

/** The descendants of `root` in `table`, deepest first. The root is not included. */
export const descendantsOf = (table, root) => {
  const byParent = new Map();
  for (const row of table || []) {
    if (row.pid === row.ppid) continue;
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const seen = new Set([root]);
  let level = [root];
  for (let depth = 1; level.length; depth += 1) {
    const next = [];
    for (const parent of level) {
      for (const row of byParent.get(parent) || []) {
        if (seen.has(row.pid)) continue;
        seen.add(row.pid);
        out.push({ ...row, depth });
        next.push(row.pid);
      }
    }
    level = next;
  }
  return out.sort((a, b) => b.depth - a.depth);
};

const DEFAULT_IO = Object.freeze({ table: readProcessTable, read: readProcess });

/**
 * Signal each snapshotted descendant, deepest first, re-reading it just
 * before: it is signalled only while its ppid and start time still match.
 * Returns the pids signalled.
 */
export const killDescendants = (descendants, signal = 'SIGKILL', { read = readProcess } = {}) => {
  const killed = [];
  for (const row of descendants) {
    const now = read(row.pid);
    if (!now || now.ppid !== row.ppid || now.started !== row.started) continue;
    try { process.kill(row.pid, signal); killed.push(row.pid); } catch { /* gone */ }
  }
  return killed;
};

const liveRoot = (child) => !!child && Number.isInteger(child.pid) && child.pid > 0 && isAlive(child);

const killOne = (child, signal, table, io) => {
  // The root must be alive, so unreaped, so its pid still names this child.
  if (table && liveRoot(child)) killDescendants(descendantsOf(table, child.pid), signal, io);
  if (leadsOwnGroup(child)) {
    try { process.kill(-child.pid, signal); return true; } catch { /* fall back to the leader */ }
  }
  try { return child.kill(signal) !== false; } catch { return false; }
};

/**
 * Kill a child, its verified descendants, and its whole group when it leads
 * one. The table is read before any signal. Falls back to `child.kill` when
 * the child does not lead a group, or the group signal fails. Returns whether
 * the child was signalled. `io` is a test seam ({ table, read }).
 */
export const killProcessTree = (child, signal = 'SIGKILL', io = {}) => {
  const seam = { ...DEFAULT_IO, ...io };
  return killOne(child, signal, liveRoot(child) ? seam.table() : null, seam);
};

// ── Wrapper-exit cleanup ────────────────────────────────────────────────────

const EXIT_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const tracked = new Set();
const handlers = new Map();
let onExit = null;
let deadline = null;

/** SIGKILL every tracked group still led by a live child, with its verified descendants. Synchronous. */
export const killSupervisedGroups = (signal = 'SIGKILL', io = {}) => {
  const live = [...tracked].filter(leadsOwnGroup);
  if (live.length === 0) return 0;
  const seam = { ...DEFAULT_IO, ...io };
  const table = seam.table();
  let killed = 0;
  for (const child of live) if (killOne(child, signal, table, seam)) killed += 1;
  return killed;
};

/**
 * Kill the tracked groups in `ms`, for a host that keeps running after a
 * signal (to finish a turn) but will be SIGKILLed at a known deadline. The
 * earliest deadline armed wins. The timer does not hold the process open.
 * Returns a function that disarms it.
 */
export const armSupervisedGroupDeadline = (ms) => {
  const wait = Math.max(0, Number(ms) || 0);
  const at = Date.now() + wait;
  if (deadline && deadline.at <= at) return deadline.cancel;
  if (deadline) deadline.cancel();
  const timer = setTimeout(() => { deadline = null; killSupervisedGroups(); }, wait);
  timer.unref?.();
  const entry = { at, cancel: () => { clearTimeout(timer); if (deadline === entry) deadline = null; } };
  deadline = entry;
  return entry.cancel;
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
      // A host that handles this signal has taken over shutdown: it may be
      // finishing the turn these groups belong to, so they are left alone and
      // the host's deadline or exit kills them.
      if (process.listenerCount(signal) !== 1) return;
      killSupervisedGroups();
      // Listening for a signal replaces its default action. With nothing else
      // handling it, restore that action and re-raise, so the wrapper still
      // terminates exactly as it would have without this module.
      uninstall();
      process.kill(process.pid, signal);
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
