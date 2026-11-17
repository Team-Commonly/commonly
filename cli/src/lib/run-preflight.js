// F515: what `agent run` checks before it starts waiting. Both newcomers in the
// week of 11-09 created an agent and never got it listening: the page waited,
// and the terminal said nothing they could act on. So the run checks the three
// things the connect command needs (Node 22+, the harness installed, the
// harness signed in), and prints one plain line for each that fails.
//
// A first run (the pasted command, no saved record) stops on a failure, and
// tells the instance why, by reason code only, so the page and the pod can say
// it. A run with a saved record only warns: that is a seat that has run here
// before, and a login probe that reads it wrong must not take it down.

import { spawn } from 'child_process';
import { readFileSync } from 'fs';

import { checkNode, FAIL } from './doctor.js';
import { loginState } from './adapter-login.js';
import { missingHarnessHint } from './missing-harness.js';
import { withClaudePath } from './adapters/claude.js';
import { resolveWindowsCommandWithReason } from './windows-command.js';

// The reason codes the instance accepts (POST /api/agents/runtime/listen-blocked).
// A code, never text: nothing from this computer but the code is sent.
export const LISTEN_BLOCKED_REASONS = ['node-too-old', 'harness-signed-out'];

// The floor the CLI declares, read as `commonly doctor` reads it.
const CLI_ENGINES_NODE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines?.node;
  } catch {
    return undefined;
  }
})();

const LABEL = { claude: 'Claude Code', codex: 'Codex' };
const SIGN_IN = { claude: 'claude', codex: 'codex login' };

/** The Node finding, or null when this Node meets the CLI's floor. */
export const nodeFinding = ({ nodeVersion = process.versions.node, enginesRange = CLI_ENGINES_NODE } = {}) => {
  const check = checkNode({ nodeVersion, enginesRange });
  if (check.status !== FAIL) return null;
  const floor = /(\d+)/.exec(String(enginesRange || ''))?.[1] || '22';
  return {
    reason: 'node-too-old',
    harness: null,
    line: `This computer has Node ${nodeVersion}, and Commonly needs Node ${floor} or later. `
      + `Install Node ${floor} from nodejs.org, then run this line again.`,
  };
};

/**
 * The exit code of a harness's login status, run as its adapter runs it: the
 * same command `detect()` found (Claude Code with its own ~/.local/bin on
 * PATH, where the native installer puts it), without a shell. Through a shell
 * on Windows a name cmd can't find exits 1, which is the signed-out code, and
 * would stop a run that is signed in. null when the command can't be resolved
 * or the probe can't run or times out (no verdict).
 */
export const runHarnessLoginStatus = (name, args, {
  env = process.env,
  platform = process.platform,
  resolve = resolveWindowsCommandWithReason,
  spawnFn = spawn,
  timeoutMs = 10_000,
} = {}) => new Promise((done) => {
  const childEnv = name === 'claude' ? withClaudePath(env) : env;
  const located = resolve(name, { env: childEnv, platform });
  if (!located?.command) {
    done(null);
    return;
  }
  let child;
  try {
    child = spawnFn(located.command, [...(located.args || []), ...args], {
      stdio: 'ignore', windowsHide: true, env: childEnv, shell: false,
    });
  } catch {
    done(null);
    return;
  }
  const timer = setTimeout(() => { child.kill(); done(null); }, timeoutMs);
  child.on('error', () => { clearTimeout(timer); done(null); });
  child.on('exit', (code) => { clearTimeout(timer); done(typeof code === 'number' ? code : null); });
});

/**
 * The harness findings for one adapter: not installed, or installed and not
 * signed in. `checkInstalled` is false where the caller has already looked (a
 * first run's bootstrap does, and reports it on its own route). A seat that
 * runs on its own provider block needs no harness login, and a key in the
 * environment is skipped by loginState itself.
 */
export const harnessFindings = async ({
  adapterName,
  adapter,
  environment = null,
  checkInstalled = true,
  env = process.env,
  runStatus = (name, args) => runHarnessLoginStatus(name, args, { env }),
}) => {
  if (!adapter || !adapterName) return [];
  if (checkInstalled) {
    let installed = false;
    try { installed = Boolean(await adapter.detect()); } catch { /* not installed */ }
    if (!installed) {
      return [{
        reason: 'harness-missing',
        harness: adapterName,
        line: `${LABEL[adapterName] || adapterName} isn't installed on this computer. ${missingHarnessHint(adapterName)}`,
      }];
    }
  }
  if (environment?.provider !== undefined || !LABEL[adapterName]) return [];
  const signedIn = await loginState(adapterName, { runStatus, env });
  if (signedIn !== false) return [];
  return [{
    reason: 'harness-signed-out',
    harness: adapterName,
    line: `${LABEL[adapterName]} is installed but not signed in on this computer. `
      + `Run ${SIGN_IN[adapterName]} once to sign in, then run this line again.`,
  }];
};

/**
 * What the run does with its findings. A first run (the pasted command) stops,
 * and the first finding is the one reported. A run from a saved record only
 * warns and goes on: that seat has run here before, and a probe that misreads
 * it must not take it down.
 */
export const preflightOutcome = (findings, { firstRun }) => {
  if (!findings.length) return { stop: false, lines: [], report: null };
  if (firstRun) return { stop: true, lines: findings.map((f) => f.line), report: findings[0] };
  return { stop: false, lines: findings.map((f) => `warning: ${f.line}`), report: null };
};

/**
 * Tell the instance why this agent isn't listening yet. Best effort, as the
 * harness-missing report: an older instance without the route, or a failed
 * call, must not hide the line the person needs in the terminal (which is
 * printed first). A missing harness has its own route, posted by bootstrap.
 */
export const reportListenBlocked = async (client, finding) => {
  if (!finding) return;
  try {
    if (!LISTEN_BLOCKED_REASONS.includes(finding.reason)) return;
    await client?.post?.('/api/agents/runtime/listen-blocked', { reason: finding.reason, harness: finding.harness });
  } catch {
    // The terminal line is the answer either way.
  }
};
