/**
 * How `agent run` stops on a signal while supervised process groups may be
 * live (see @commonlyai/seats/process-group).
 *
 * SIGTERM keeps the in-flight turn: the run loop stops polling and lets the
 * turn finish. A launchd seat is SIGKILLed ExitTimeOut seconds after SIGTERM,
 * and that SIGKILL cannot be caught, so a supervised group (outside the seat's
 * own group, which launchd kills) would outlive the seat. So on a launchd
 * seat, SIGTERM also arms a deadline a margin before ExitTimeOut, and the exit
 * path kills whatever groups are left when the turn ends first.
 *
 * The deadline is armed only when the seat's plist exists. A seat without one
 * (the daemon spawns it) is stopped with SIGTERM and never SIGKILLed, so it
 * relies on the exit path alone, and a reassignment or config change does not
 * cut the in-flight turn.
 *
 * ExitTimeOut is read from the seat's plist and never written. In a plist that
 * exists, an unset, zero or unreadable value is launchd's default of 20 s,
 * because launchd will SIGKILL that seat.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { armSupervisedGroupDeadline, killSupervisedGroups } from '@commonlyai/seats/process-group';

export const DEFAULT_EXIT_TIMEOUT_S = 20;
const MAX_MARGIN_MS = 5000;
const SEAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The seat's launchd plist path, or null for a name that cannot be a file name. */
export const seatPlistPath = (name, home = homedir()) => (typeof name === 'string' && SEAT_NAME.test(name)
  ? join(home, 'Library', 'LaunchAgents', `me.commonly.seat-${name}.plist`)
  : null);

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);

/**
 * ExitTimeOut in seconds, or null when the plist is missing, has none, or
 * holds a value launchd would not use as a timeout. An XML plist is read
 * directly; a binary one through `plutil -extract` (read-only).
 */
export const readExitTimeOut = (path, { readFile = readFileSync, run = spawnSync } = {}) => {
  if (!path) return null;
  let raw;
  try { raw = readFile(path); } catch { return null; }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (text.startsWith('bplist')) {
    try {
      const out = run('plutil', ['-extract', 'ExitTimeOut', 'raw', '-o', '-', path], { encoding: 'utf8', timeout: 5000 });
      return out.status === 0 ? positive(Number(String(out.stdout).trim())) : null;
    } catch { return null; }
  }
  const match = /<key>\s*ExitTimeOut\s*<\/key>\s*<(integer|real)>\s*([0-9.]+)\s*<\/\1>/.exec(text);
  return match ? positive(Number(match[2])) : null;
};

/**
 * Whether the seat's plist exists, and its ExitTimeOut (null when unset or
 * unreadable). Only an existing plist means launchd will SIGKILL this seat.
 */
export const readSeatPlist = (path, { exists = existsSync, ...deps } = {}) => {
  if (!path || !exists(path)) return { present: false, exitTimeOut: null };
  return { present: true, exitTimeOut: readExitTimeOut(path, deps) };
};

/** Milliseconds after SIGTERM to kill the groups: ExitTimeOut less a margin of 5 s or a quarter, whichever is less. */
export const groupKillDeadlineMs = (exitTimeOutS) => {
  const totalMs = (positive(exitTimeOutS) ?? DEFAULT_EXIT_TIMEOUT_S) * 1000;
  return Math.floor(totalMs - Math.min(MAX_MARGIN_MS, totalMs / 4));
};

/**
 * `requestStop(signal)` stops the run loop and, on SIGTERM to a seat with a
 * plist, arms the group deadline; `onExit` kills the groups left at exit.
 * `deps` is a test seam.
 */
export const createSeatStop = ({ name, stop, home, deps = {} } = {}) => {
  const {
    arm = armSupervisedGroupDeadline,
    kill = killSupervisedGroups,
    readPlist = readSeatPlist,
  } = deps;
  return {
    requestStop(signal) {
      stop();
      if (signal !== 'SIGTERM') return null;
      const plist = readPlist(seatPlistPath(name, home));
      if (!plist.present) return null;
      const deadlineMs = groupKillDeadlineMs(plist.exitTimeOut);
      arm(deadlineMs);
      return deadlineMs;
    },
    onExit() { kill(); },
  };
};
