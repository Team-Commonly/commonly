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
 * confines with its own permission profiles (mode.js). pi is a scope boundary,
 * not a gap in this check: it refuses a declared sandbox itself, so a
 * Connect-page pi seat is saved without one and runs unconfined
 * (default-environment.js, ADAPTERS_WITH_DEFAULT_SANDBOX); confining pi
 * belongs to pi's own sandbox work.
 */

import { normalizeSandboxTrust } from '../environment.js';
import { PUBLIC_SANDBOX_MODES, resolvePublicSandboxMode } from './mode.js';
import { detectBwrap as defaultDetectBwrap } from './bwrap.js';
import { detectSeatbelt as defaultDetectSeatbelt } from './seatbelt.js';

// The Seatbelt modes come from mode.js, as grant-broker-guard's do, so a mode
// added there is not silently missing here.
const SEATBELT_MODES = PUBLIC_SANDBOX_MODES;

const ADAPTER_LABELS = { claude: 'Claude Code', opencode: 'OpenCode', qwen: 'Qwen Code' };

const HOSTED_LINE = '  - A hosted agent: choose "Run it here" on the Connect page. Nothing runs on this machine.';

/** What a person on native Windows can do instead. */
export const windowsSandboxMessage = (adapterName) => {
  const label = ADAPTER_LABELS[adapterName] || adapterName;
  // WSL is offered only where the Linux sandbox can run the CLI: not Claude
  // Code (see linuxClaudeMessage).
  return [
    `Commonly runs a connected ${label} inside a sandbox, and has no sandbox for Windows yet,`,
    'so this agent cannot listen for @mentions from native Windows. Instead:',
    ...(adapterName === 'claude'
      ? ['  - Use Commonly from your own Claude Code sessions: the Connect page shows a PowerShell `claude mcp add` command.']
      : [`  - WSL 2 (Ubuntu): install Node and ${label} inside WSL, run \`sudo apt install bubblewrap\`,`
        + ' then run these same commands there.']),
    HOSTED_LINE,
  ].join('\n');
};

/**
 * Claude Code on Linux (WSL included) for any seat but a workspace one. Only
 * the workspace jail (#2784) carries what Claude needs: its install, a HOME
 * of its own and a copy of the login. The public jail binds the system binary
 * folders only, so a confined spawn could not even start Claude (Ubuntu run,
 * 2026-10-16), and giving it the login would hand strangers a jail that holds
 * it. A workspace seat needs every pod it answers in to be invite-only.
 */
export const linuxClaudeMessage = () => [
  'Commonly runs a connected Claude Code inside a sandbox. On Linux (WSL included) it does that only',
  'for an agent whose pods are all invite-only, and this one is not, so it cannot listen for @mentions here. Instead:',
  '  - From an invite-only pod: run the commands its Connect page shows, from your project\'s folder.',
  '  - Use Commonly from your own Claude Code sessions: the Connect page shows a `claude mcp add` command.',
  HOSTED_LINE,
].join('\n');

/** Why this host cannot confine the seat, or null when it can (or the seat declares no sandbox). */
export const hostSandboxRefusal = ({
  environment,
  adapterName,
  platform = process.platform,
  detectBwrap = defaultDetectBwrap,
  detectSeatbelt = defaultDetectSeatbelt,
} = {}) => {
  if (!Object.prototype.hasOwnProperty.call(ADAPTER_LABELS, adapterName)) return null;
  const sandbox = normalizeSandboxTrust(environment?.sandbox);
  if (!sandbox || typeof sandbox !== 'object') return null;
  // Every host-confined trust (public, and workspace since TASK-294) derives its
  // mode here; any other trust gets back only the mode it declared.
  const mode = sandbox.mode ?? resolvePublicSandboxMode(sandbox, platform);
  if (mode !== 'bwrap' && !SEATBELT_MODES.has(mode)) return null;

  if (platform === 'win32') return windowsSandboxMessage(adapterName);
  // A workspace claude seat falls through to the bubblewrap probe below; the
  // probe failing, for any reason, is a refusal like any other adapter's.
  if (mode === 'bwrap' && adapterName === 'claude' && sandbox.trust !== 'workspace') {
    return linuxClaudeMessage();
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

export default { hostSandboxRefusal, linuxClaudeMessage, windowsSandboxMessage };
