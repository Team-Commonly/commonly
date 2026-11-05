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
 * Only the adapters that run inside these mechanisms are checked, plus Codex
 * on native Windows. Codex confines a public seat with its own permission
 * profile (adapters/codex.js), which runs on macOS and Linux but not on native
 * Windows (windowsCodexMessage below). pi confines an explicitly public seat
 * with Seatbelt and refuses one it cannot confine at attach
 * (validateEnvironment) and at spawn (adapters/pi.js); a Connect-page pi seat
 * declares no sandbox and is not checked here.
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

// WSL runs the Linux sandbox, which carries every adapter, Claude Code
// included (F96), and Codex, whose Linux sandbox is bubblewrap as well.
const wslLine = (label) => `  - WSL 2 (Ubuntu): install Node and ${label} inside WSL, run \`sudo apt install bubblewrap\`,`
  + ' then run these same commands there.';

/** What a person on native Windows can do instead. */
export const windowsSandboxMessage = (adapterName) => {
  const label = ADAPTER_LABELS[adapterName] || adapterName;
  // Claude Code also has the MCP command, which needs no sandbox.
  return [
    `Commonly runs a connected ${label} inside a sandbox, and has no sandbox for Windows yet,`,
    'so by default this agent cannot listen for @mentions from native Windows. You can:',
    wslLine(label),
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

/**
 * What a person running a public Codex seat on native Windows can do instead.
 * No --unsandboxed line: that opt-in admits only an adapter whose tool policy
 * confines it without a shell (windows-unsandboxed.js), and Codex has a shell.
 */
export const windowsCodexMessage = () => [
  "Codex's own Windows sandbox can't enforce the file-read limits a connected Codex runs under,",
  'so this agent cannot listen for @mentions from native Windows. You can:',
  wslLine('Codex'),
  HOSTED_LINE,
].join('\n');

/** Why this host cannot confine the seat, or null when it can (or the seat declares no sandbox). */
export const hostSandboxRefusal = ({
  environment,
  adapterName,
  platform = process.platform,
  // D245: the user's own opt-in for this run (windows-unsandboxed.js
  // hostUnconfinedForRun). Never derived from the environment.
  hostUnconfined = false,
  detectBwrap = defaultDetectBwrap,
  detectSeatbelt = defaultDetectSeatbelt,
} = {}) => {
  // D250: a public Codex seat's profile denies reads of ~/.commonly, ~/.ssh and
  // the other secret folders (adapters/codex.js). On native Windows codex-cli
  // 0.162.1 refused every such turn: "windows unelevated restricted-token
  // sandbox cannot enforce split filesystem read restrictions directly;
  // refusing to run unsandboxed" (byo-windows run 41960954496, the first Codex
  // walk there). Those denies are the seat's boundary and stay, so the run
  // stops here once instead of failing every turn. The trust test is the
  // adapter's own (codex.js publicSandboxMode).
  if (adapterName === 'codex') {
    return platform === 'win32' && normalizeSandboxTrust(environment?.sandbox)?.trust === 'public'
      ? windowsCodexMessage()
      : null;
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

export default { hostSandboxRefusal, windowsSandboxMessage, windowsCodexMessage };
