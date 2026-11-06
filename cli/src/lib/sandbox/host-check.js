/**
 * Can THIS host confine the seat it is about to run? Asked once, before the
 * first poll.
 *
 * A public seat's sandbox is resolved per host (mode.js): Seatbelt on macOS,
 * bubblewrap elsewhere. `agent attach --env` checks that mechanism up front;
 * `agent run` did not, so a public seat on a host without it (native Windows,
 * or Linux without bubblewrap) would start, poll, and fail every turn while
 * the pod saw nothing.
 *
 * Only the adapters that run inside these mechanisms are checked. Codex
 * confines with its own permission profiles (mode.js), except on native
 * Windows: there a public Codex seat is refused, and any other runs only by the
 * person's own opt-in (CODEX_WINDOWS_MESSAGE below). pi confines an
 * explicitly public seat with Seatbelt and refuses one it cannot confine at
 * attach (validateEnvironment) and at spawn (adapters/pi.js); a Connect-page pi
 * seat declares no sandbox and is not checked here.
 */

import { normalizeSandboxTrust } from '../environment.js';
import { PUBLIC_SANDBOX_MODES, resolvePublicSandboxMode } from './mode.js';
import { detectBwrap as defaultDetectBwrap } from './bwrap.js';
import { detectSeatbelt as defaultDetectSeatbelt } from './seatbelt.js';

// D245: the Windows opt-in (windows-unsandboxed.js re-exports it; defined here to avoid an import cycle).
export const UNSANDBOXED_FLAG = '--unsandboxed';

// The Seatbelt modes come from mode.js, as grant-broker-guard's do, so a mode
// added there is not silently missing here.
const SEATBELT_MODES = PUBLIC_SANDBOX_MODES;

const ADAPTER_LABELS = { claude: 'Claude Code', opencode: 'OpenCode', qwen: 'Qwen Code' };

const HOSTED_LINE = '  - A hosted agent: choose "Run it here" on the Connect page. Nothing runs on this machine.';

const CODEX_WSL_LINE = '  - WSL 2 (Ubuntu): install Node and Codex inside WSL, run `sudo apt install bubblewrap`,'
  + ' then run these same commands there.';

/**
 * Codex's unelevated Windows sandbox cannot enforce the split read denies a
 * public seat's profile carries ("refusing to run unsandboxed"), and Codex has
 * no tool policy beneath that profile, so an unconfined Codex is a full shell
 * driven by pod content. That is why a public Codex seat on native Windows
 * always refuses, and why even the opt-in reaches only a seat whose every pod
 * is confirmed private (windows-unsandboxed.js), re-read before every turn.
 * Codex's elevated Windows sandbox is the hardened path; Commonly doesn't drive
 * it yet.
 */
const CODEX_WINDOWS_MESSAGE = [
  "Codex can't enforce a sandbox on Windows without its elevated setup,",
  'so by default this agent cannot listen for @mentions from native Windows. You can:',
  `  - In invite-only pods, run it without a sandbox: add ${UNSANDBOXED_FLAG}`
    + ` (commonly agent run <name> ${UNSANDBOXED_FLAG}, or commonly daemon install ${UNSANDBOXED_FLAG}).`
    + ' Nothing confines it: it runs with your own access to files and commands, anyone in the pod,'
    + ' people you invite later included, can direct it, and it gets no connector grants.',
  CODEX_WSL_LINE,
  HOSTED_LINE,
].join('\n');

// The seat can't take the flag: its pods rule it out, or it declares itself
// public. Naming the flag would only send the person round in a circle.
const CODEX_WINDOWS_PUBLIC_MESSAGE = [
  'This agent is public: its settings say so, or a pod it answers in is publicly readable or open to join,',
  "or did not report whether it is. A public agent needs a sandbox, which Codex can't enforce on Windows"
    + ' without its elevated setup. You can:',
  CODEX_WSL_LINE,
  HOSTED_LINE,
].join('\n');

/** What a person on native Windows can do instead. */
export const windowsSandboxMessage = (adapterName) => {
  if (adapterName === 'codex') return CODEX_WINDOWS_MESSAGE;
  const label = ADAPTER_LABELS[adapterName] || adapterName;
  // WSL runs the Linux sandbox, which carries every adapter, Claude Code
  // included (F96). Claude Code also has the MCP command, which needs none.
  return [
    `Commonly runs a connected ${label} inside a sandbox, and has no sandbox for Windows yet,`,
    'so by default this agent cannot listen for @mentions from native Windows. You can:',
    `  - WSL 2 (Ubuntu): install Node and ${label} inside WSL, run \`sudo apt install bubblewrap\`,`
      + ' then run these same commands there.',
    // D245: the user's own choice, never a default (sandbox/windows-unsandboxed.js).
    ...(adapterName === 'claude'
      ? [`  - Run it without an OS sandbox: add ${UNSANDBOXED_FLAG}`
        + ` (commonly agent run <name> ${UNSANDBOXED_FLAG}, or commonly daemon install ${UNSANDBOXED_FLAG}).`
        + " It keeps Commonly's restricted tool settings and gets no shell, but nothing at the OS level confines it, and it gets no connector grants."]
      : []),
    ...(adapterName === 'claude'
      ? ['  - Use Commonly from your own Claude Code sessions: the Connect page shows a PowerShell `claude mcp add` command.']
      : []),
    HOSTED_LINE,
  ].join('\n');
};

/** Why this host cannot confine the seat, or null when it can (or the seat declares no sandbox). */
export const hostSandboxRefusal = ({
  environment,
  adapterName,
  platform = process.platform,
  // D245: the user's own opt-in for this run (windows-unsandboxed.js
  // hostUnconfinedForRun). Never derived from the environment.
  hostUnconfined = false,
  // The person asked for the opt-in, whether or not the seat qualified. Only
  // chooses Codex's words: it never lets a seat through.
  optedIn = false,
  detectBwrap = defaultDetectBwrap,
  detectSeatbelt = defaultDetectSeatbelt,
} = {}) => {
  if (adapterName === 'codex') {
    if (platform !== 'win32') return null;
    // Keyed on trust, not mode: Codex resolves no Seatbelt or bwrap mode of its
    // own, and a legacy `internal` normalizes to public. Workspace trust is
    // left to Codex's own refusal, at attach and at spawn on every platform,
    // so WSL advice would only send that seat to a second refusal.
    const trust = normalizeSandboxTrust(environment?.sandbox)?.trust;
    if (trust === 'workspace') return null;
    if (trust === 'public') return optedIn === true ? CODEX_WINDOWS_PUBLIC_MESSAGE : CODEX_WINDOWS_MESSAGE;
    // No public trust: `agent run` removed the block for this run after
    // confirming every pod private, or the seat never had one. Either way it
    // would run unconfined, which only the person's own opt-in allows.
    return hostUnconfined === true ? null : CODEX_WINDOWS_MESSAGE;
  }
  if (!Object.prototype.hasOwnProperty.call(ADAPTER_LABELS, adapterName)) return null;
  const sandbox = normalizeSandboxTrust(environment?.sandbox);
  if (!sandbox || typeof sandbox !== 'object') return null;
  // Every host-confined trust (public, and workspace since TASK-294) derives its
  // mode here; any other trust gets back only the mode it declared.
  const mode = sandbox.mode ?? resolvePublicSandboxMode(sandbox, platform);
  if (mode !== 'bwrap' && !SEATBELT_MODES.has(mode)) return null;

  if (platform === 'win32') {
    return hostUnconfined === true && adapterName === 'claude' ? null : windowsSandboxMessage(adapterName);
  }
  if (mode === 'bwrap') {
    const bwrap = detectBwrap();
    return bwrap.available ? null : `This seat runs in a bubblewrap sandbox, which is not available here. ${bwrap.error}`;
  }
  const seatbelt = detectSeatbelt();
  return seatbelt.available
    ? null
    : `This seat runs in a macOS Seatbelt sandbox (sandbox.mode=${mode}), which is not available here. ${seatbelt.error}`;
};

export default { hostSandboxRefusal, windowsSandboxMessage };
