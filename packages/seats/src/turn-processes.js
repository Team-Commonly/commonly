/**
 * Processes a turn leaves running.
 *
 * A turn can start work that outlives it. A dev server backgrounded from a
 * shell tool (`npm exec vite &`) is orphaned the moment that shell exits and
 * is reparented to launchd, where no group kill or descendant walk from the
 * turn's child can reach it. Six such trees, one to four days old, took the
 * fleet host's swap to 12 GB (SRE, 2026-11-01).
 *
 * So a turn's child is started with a fresh marker in its environment, which
 * every process it starts inherits however it detaches. When the child has
 * closed, the processes still carrying the marker are stopped: SIGTERM, then
 * SIGKILL after a grace for any still alive. That includes a lasting server
 * the turn started on first use, such as tmux, and a seat it restarted. A
 * process started with COMMONLY_KEEP_PROCESS=1 is left running, and so is
 * anything it starts, even one that clears the setting; the turn's child itself
 * never inherits it. COMMONLY_TURN_REAP=0 turns the whole check off.
 *
 * Only processes started since the turn began are read, and each one's
 * environment is only compared against the marker and the keep setting. Each
 * pid is re-read just before it is signalled, and is signalled only while its
 * start time is still the one recorded, so a reused pid is left alone.
 *
 * What it does not catch: on macOS `ps -E` cannot read the environment of an
 * Apple platform binary (sh, bash, sleep), so one of those is stopped only as
 * a descendant of a marked process. A process that clears its environment
 * loses the marker. Both are left running. The same unreadable environment
 * hides a keep setting: a kept Apple binary is not seen as kept, so a process
 * it starts is kept only if that process keeps the setting itself.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  PROCESS_GROUPS_SUPPORTED, readProcesses, readProcessTable, startedMs,
} from './process-group.js';

export const TURN_MARK_ENV = 'COMMONLY_TURN_ID';
export const KEEP_PROCESS_ENV = 'COMMONLY_KEEP_PROCESS';
export const TURN_REAP_ENV = 'COMMONLY_TURN_REAP';
export const TURN_REAP_GRACE_MS = 5_000;
// How far before the turn a process's recorded start may read and still be
// looked at. lstart has one-second resolution, and on Linux ps derives it from
// the boot time, which drifts from the wall clock by a second or more. The
// window only bounds what is read; the marker decides.
export const TURN_START_SLACK_MS = 60_000;

export const turnReapEnabled = (env = process.env) => PROCESS_GROUPS_SUPPORTED && env?.[TURN_REAP_ENV] !== '0';

const PS_ENV = { ...process.env, LC_ALL: 'C' };

// pid -> the set of tokens its environment reads as. A pid whose environment
// could not be read has no entry, or a set without NAME=value pairs.
const readEnvironmentsDarwin = (pids) => {
  const out = new Map();
  const res = spawnSync('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', pids.join(',')], {
    encoding: 'utf8', env: PS_ENV, timeout: 5000, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return out;
  for (const line of String(res.stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), new Set(match[2].split(/\s+/)));
  }
  return out;
};

const readEnvironmentsLinux = (pids) => {
  const out = new Map();
  for (const pid of pids) {
    try {
      out.set(pid, new Set(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')));
    } catch { /* gone, or not readable */ }
  }
  return out;
};

export const readEnvironments = (pids) => {
  if (!pids.length || !PROCESS_GROUPS_SUPPORTED) return new Map();
  return process.platform === 'linux' ? readEnvironmentsLinux(pids) : readEnvironmentsDarwin(pids);
};

const selfAndAncestors = (table, pid) => {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const out = new Set([pid]);
  for (let row = byPid.get(pid); row && row.ppid > 0 && !out.has(row.ppid); row = byPid.get(row.ppid)) {
    out.add(row.ppid);
  }
  return out;
};

/**
 * The processes still carrying `mark`, as { pid, ppid, started }: started at
 * or after `since` (ms), neither this process nor an ancestor of it, and
 * neither kept nor under a kept one. Each one brings its descendants, except a
 * kept one and everything
 * under it, whose environments may be unreadable. The start-time window only
 * limits what is read; the marker is what decides. `io` is a test seam
 * ({ table, envs, self }).
 */
export const findTurnProcesses = (mark, since, io = {}) => {
  const { table = readProcessTable, envs = readEnvironments, self = process.pid } = io;
  if (!mark) return [];
  const rows = table();
  if (!rows) return [];
  const skip = selfAndAncestors(rows, self);
  const floor = Number(since) - TURN_START_SLACK_MS;
  const recent = rows.filter((row) => !skip.has(row.pid) && startedMs(row.started) >= floor);
  const environments = envs(recent.map((row) => row.pid));
  const marked = `${TURN_MARK_ENV}=${mark}`;
  const keep = `${KEEP_PROCESS_ENV}=1`;
  const kept = (pid) => environments.get(pid)?.has(keep) === true;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  // A kept process keeps what it starts even when that drops the setting.
  const underKept = (row) => {
    for (let up = byPid.get(row.ppid), seen = new Set(); up && !seen.has(up.pid); up = byPid.get(up.ppid)) {
      if (kept(up.pid)) return true;
      seen.add(up.pid);
    }
    return false;
  };
  const found = new Map();
  for (const row of recent) {
    if (environments.get(row.pid)?.has(marked) && !kept(row.pid) && !underKept(row)) found.set(row.pid, row);
  }
  const byParent = new Map();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  for (const stack = [...found.keys()]; stack.length;) {
    for (const child of byParent.get(stack.pop()) || []) {
      if (found.has(child.pid) || skip.has(child.pid) || kept(child.pid)) continue;
      found.set(child.pid, child);
      stack.push(child.pid);
    }
  }
  return [...found.values()];
};

/**
 * Stop what `findTurnProcesses` returns. SIGTERM is sent before this returns;
 * `done` settles after `graceMs`, once anything still alive has had SIGKILL.
 * A pid is signalled only while its start time is the one recorded, read for
 * all of them in one ps call per signal. The grace timer holds the process
 * open until SIGKILL has gone out, so a seat stopped mid-turn still escalates.
 * `io` adds `read` (pids -> rows) to the find seam.
 */
export const reapTurnProcesses = (mark, since, { graceMs = TURN_REAP_GRACE_MS, io = {} } = {}) => {
  const read = io.read || readProcesses;
  const signal = (rows, name) => {
    const now = new Map((read(rows.map((row) => row.pid)) || []).map((row) => [row.pid, row]));
    return rows.filter((row) => {
      if (now.get(row.pid)?.started !== row.started) return false;
      try { process.kill(row.pid, name); return true; } catch { return false; }
    });
  };
  const termed = signal(findTurnProcesses(mark, since, io), 'SIGTERM');
  const done = termed.length === 0
    ? Promise.resolve({ killed: [] })
    : new Promise((resolve) => {
      setTimeout(() => resolve({ killed: signal(termed, 'SIGKILL').map((row) => row.pid) }), graceMs);
    });
  return { termed: termed.map((row) => row.pid), done };
};

/**
 * One turn's marker. `env` is the child's environment with the marker added;
 * `reap(child)` runs once the child has closed, and returns what
 * `reapTurnProcesses` does, or null when the check is off, the child never had
 * a pid, or the turn was already reaped.
 */
export const markTurn = (env, { enabled = turnReapEnabled(), now = Date.now, graceMs } = {}) => {
  if (!enabled) return { env, mark: null, reap: () => null };
  const mark = randomUUID();
  const since = now();
  // A keep setting the seat itself was started with would keep every turn.
  const childEnv = { ...env, [TURN_MARK_ENV]: mark };
  delete childEnv[KEEP_PROCESS_ENV];
  let reaped = false;
  return {
    env: childEnv,
    mark,
    reap: (child, { io } = {}) => {
      if (reaped || !Number.isInteger(child?.pid) || child.pid <= 0) return null;
      reaped = true;
      try { return reapTurnProcesses(mark, since, { graceMs, io }); } catch { return null; }
    },
  };
};

/** The log line for a reap that stopped something, or null. */
export const describeTurnReap = (result) => {
  if (!result?.termed?.length) return null;
  const n = result.termed.length;
  return `stopped ${n} process${n === 1 ? '' : 'es'} this turn left running (pid ${result.termed.join(', ')}); `
    + `start one with ${KEEP_PROCESS_ENV}=1 to keep it across turns`;
};
