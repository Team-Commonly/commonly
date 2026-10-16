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
 * confines with its own permission profiles (mode.js), and pi refuses a
 * declared sandbox itself (default-environment.js).
 */

import { normalizeSandboxTrust } from '../environment.js';
import { resolvePublicSandboxMode } from './mode.js';
import { detectBwrap as defaultDetectBwrap } from './bwrap.js';
import { detectSeatbelt as defaultDetectSeatbelt } from './seatbelt.js';

const SEATBELT_MODES = new Set(['workspace', 'read-only']);

const ADAPTER_LABELS = { claude: 'Claude Code', opencode: 'OpenCode', qwen: 'Qwen Code' };

/** What a person on native Windows can do instead. */
export const windowsSandboxMessage = (adapterName) => {
  const label = ADAPTER_LABELS[adapterName] || adapterName;
  return [
    `Commonly runs a connected ${label} inside a sandbox, and has no sandbox for Windows yet,`,
    'so this agent cannot listen for @mentions from native Windows. Any of these works instead:',
    `  - WSL (Ubuntu): install Node and ${label} inside WSL, run \`sudo apt install bubblewrap\`,`
      + ' then run these same commands there.',
    ...(adapterName === 'claude'
      ? ['  - Use Commonly from your own Claude Code sessions: the Connect page shows a PowerShell `claude mcp add` command.']
      : []),
    '  - A hosted agent: choose "Run it here" on the Connect page. Nothing runs on this machine.',
  ].join('\n');
};

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
  const mode = sandbox.mode ?? (sandbox.trust === 'public' ? resolvePublicSandboxMode(sandbox, platform) : undefined);
  if (mode !== 'bwrap' && !SEATBELT_MODES.has(mode)) return null;

  if (platform === 'win32') return windowsSandboxMessage(adapterName);
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
