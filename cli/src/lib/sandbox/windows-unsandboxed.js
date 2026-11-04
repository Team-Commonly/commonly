/**
 * D245: the user's own opt-in to run an agent without a sandbox on native
 * Windows.
 *
 * Commonly confines a public seat with Seatbelt on macOS and bubblewrap on
 * Linux (mode.js). Windows has neither, so without this a public Claude Code,
 * OpenCode or Qwen seat is refused on Windows (host-check.js). The opt-in
 * keeps that refusal as the default and lets the person at the keyboard choose
 * otherwise, for this machine only:
 *
 * - `commonly agent run <name> --unsandboxed` for one foreground run, or
 * - `commonly daemon install --unsandboxed`, which writes the marker below; the
 *   seats that daemon spawns read it. Installing again without the flag, or
 *   uninstalling, removes it.
 *
 * Only a LOCAL action sets it. Nothing the server sends (a seat's declared
 * environment, an adopted-seat row, a pod's settings) can create the marker or
 * stand in for the flag: `unsandboxedRunEnvironment` takes the decision as an
 * argument and never reads it from the environment it rewrites.
 *
 * The stored record keeps its public sandbox. Only the environment a single
 * run hands its adapter is rewritten, and only when this host cannot confine
 * it. The rewrite drops the sandbox to `mode: 'none'` with no trust, so the
 * grant broker guard withholds connector grants from the seat
 * (`sandbox_mode_none`): an unconfined seat never carries a granter's access.
 *
 * Codex is untouched: it confines with its own permission profiles and is not
 * among the adapters host-check refuses here.
 */

import { existsSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { writeServiceFile } from '../daemon-service.js';
import { UNSANDBOXED_FLAG, hostSandboxRefusal } from './host-check.js';

export { UNSANDBOXED_FLAG };

export const unsandboxedMarkerPath = (home = homedir()) => join(home, '.commonly', 'daemon', 'unsandboxed.json');

/** The flag is a Windows answer to a Windows gap; anywhere else it is refused. */
export const unsandboxedFlagRefusal = (platform = process.platform) => (platform === 'win32'
  ? null
  : `${UNSANDBOXED_FLAG} is only for native Windows, which has no sandbox for agents yet. On this machine agents run in a sandbox.`);

export const loadUnsandboxedOptIn = ({
  platform = process.platform, home = homedir(), exists = existsSync, read = readFileSync,
} = {}) => {
  if (platform !== 'win32') return false;
  const file = unsandboxedMarkerPath(home);
  if (!exists(file)) return false;
  try {
    const value = JSON.parse(read(file, 'utf8'));
    return value?.unsandboxed === true && value?.platform === 'win32';
  } catch {
    return false;
  }
};

export const saveUnsandboxedOptIn = ({ home = homedir(), writeFile = writeServiceFile, now = () => new Date() } = {}) => {
  writeFile(unsandboxedMarkerPath(home), `${JSON.stringify({ unsandboxed: true, platform: 'win32', optedInAt: now().toISOString() })}\n`);
};

export const clearUnsandboxedOptIn = ({ home = homedir(), exists = existsSync, remove = rmSync } = {}) => {
  const file = unsandboxedMarkerPath(home);
  if (!exists(file)) return false;
  remove(file);
  return true;
};

/**
 * Did the user opt in for THIS run? The typed flag, or, for a seat the daemon
 * spawned, the marker that `daemon install --unsandboxed` wrote. A foreground
 * run never reads the marker, so installing the daemon unsandboxed does not
 * quietly change what a hand-started `agent run` does.
 */
export const runOptedInUnsandboxed = ({ flag, env = process.env, load = loadUnsandboxedOptIn } = {}) => (
  flag === true || (env.COMMONLY_MANAGED_RUNNER === '1' && load() === true)
);

/**
 * The environment one run hands its adapter. Unchanged unless the user opted
 * in on win32 AND this host would otherwise refuse the seat.
 */
export const unsandboxedRunEnvironment = (environment, {
  adapterName, optedIn, platform = process.platform,
}) => {
  if (platform !== 'win32' || optedIn !== true) return environment;
  if (!hostSandboxRefusal({ environment, adapterName, platform })) return environment;
  return { ...environment, sandbox: { mode: 'none' } };
};

/** One plain line for the run log and `daemon status`. */
export const UNSANDBOXED_NOTICE = 'unsandboxed (opted in): no sandbox on Windows, so this agent runs with your own access to files and commands, and gets no connector grants.';

export default {
  UNSANDBOXED_FLAG,
  UNSANDBOXED_NOTICE,
  clearUnsandboxedOptIn,
  loadUnsandboxedOptIn,
  runOptedInUnsandboxed,
  saveUnsandboxedOptIn,
  unsandboxedFlagRefusal,
  unsandboxedMarkerPath,
  unsandboxedRunEnvironment,
};
