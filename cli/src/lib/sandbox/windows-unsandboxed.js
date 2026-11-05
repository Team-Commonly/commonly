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
 * stand in for the flag: `hostUnconfinedForRun` takes the decision as an
 * argument, and the adapter reads it from its spawn context, never from the
 * environment.
 *
 * Only the OS jail is skipped. The seat keeps its trust, and with it the
 * public tool policy (--setting-sources '', --strict-mcp-config, dontAsk,
 * Read(./**), the denied tools), the sanitized environment and the TASK-294
 * per-turn placement: on a host with no OS isolation that policy IS the
 * sandbox. An earlier form of this rewrote the environment to `mode: 'none'`,
 * which dropped the trust and the policy with it (review of #3388). The
 * decision now travels as `hostUnconfined` on the adapter's spawn context,
 * set only by `agent run`, so the environment, stored or derived, never
 * carries it and nothing the server sends can set it.
 *
 * Claude Code only: it is the adapter that applies the public policy without
 * its jail. OpenCode and Qwen stay refused on Windows, and so does a public
 * Codex seat, whose own Windows sandbox can't enforce its profile's read
 * denies (host-check.js windowsCodexMessage). No seat on native Windows
 * gets the grant broker (grant-broker-guard.js), and the server refuses grant
 * use for every seat on a machine whose daemon reports the opt-in.
 */

import { existsSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { writeServiceFile } from '../daemon-service.js';
import { effectiveSandboxTrust } from '../environment.js';
import { UNSANDBOXED_FLAG } from './host-check.js';

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

/** The adapters that can run their trust's tool policy without the OS jail. */
export const POLICY_ONLY_ADAPTERS = new Set(['claude']);

/**
 * Does this run skip the OS jail? Only on win32, only by the user's own
 * opt-in, only for an adapter that keeps its policy without the jail, and only
 * for a seat whose trust brings that policy (public or workspace). A seat with
 * no confined trust is the owner's own and is never jailed anywhere, so the
 * opt-in changes nothing for it, and the notice must not promise it a policy.
 */
export const hostUnconfinedForRun = ({
  optedIn, adapterName, environment, platform = process.platform,
}) => {
  // The effective trust, as host-check.js and the claude adapter read it: a
  // legacy `internal` record means `public`, so it gets the same opt-in.
  const trust = effectiveSandboxTrust(environment?.sandbox?.trust);
  return platform === 'win32' && optedIn === true && POLICY_ONLY_ADAPTERS.has(adapterName)
    && (trust === 'public' || trust === 'workspace');
};

/**
 * What the daemon's check-in says about this host. The server refuses grant
 * use for every seat on a machine that reports either Windows value.
 */
export const hostSandboxReport = ({ platform = process.platform, load = () => loadUnsandboxedOptIn({ platform }) } = {}) => {
  if (platform !== 'win32') return 'default';
  return load() === true ? 'unsandboxed-opted-in' : 'native-windows';
};

/** One plain line for the run log and `daemon status`. */
export const UNSANDBOXED_NOTICE = 'unsandboxed (opted in): Windows has no sandbox, so nothing at the OS level confines this agent. It keeps Commonly\'s restricted tool settings, gets no shell even with --allow write, and gets no connector grants.';

export default {
  UNSANDBOXED_FLAG,
  UNSANDBOXED_NOTICE,
  clearUnsandboxedOptIn,
  loadUnsandboxedOptIn,
  runOptedInUnsandboxed,
  saveUnsandboxedOptIn,
  unsandboxedFlagRefusal,
  unsandboxedMarkerPath,
  hostUnconfinedForRun,
  hostSandboxReport,
};
