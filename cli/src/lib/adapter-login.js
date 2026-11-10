import { spawn } from 'child_process';

// Whether each installed CLI adapter is signed in, by the exit code of its own
// status command. A stranger on a fresh computer otherwise learns it from a
// failed @mention ("claude exited 1: Not logged in"), after setup said all was
// well (Growth's F370 hand walk). Only the exit code is read: the commands'
// output, which names the account, is never captured or printed.
//
// Both commands exit 1 when signed out (checked 2026-11-10 under an empty HOME:
// `claude auth status --json`, `codex login status`). opencode is left out: its
// `auth list` was not checked, and a guessed probe would cry wolf.
export const LOGIN_STATUS_ARGS = {
  claude: ['auth', 'status', '--json'],
  codex: ['login', 'status'],
};

// claude treats ANTHROPIC_API_KEY as a sign-in of its own. codex does not
// treat OPENAI_API_KEY as one (`codex login status` exits 1 with it set), so
// codex has no entry here.
const KEY_ENV = { claude: 'ANTHROPIC_API_KEY' };

// Both CLIs exit exactly 1 when signed out. Any other non-zero code (2 for an
// unknown subcommand on an old CLI) is no verdict, not "signed out".
const SIGNED_OUT_EXIT = 1;

export const signedOutHint = (name) => `${name} is installed but not signed in; run \`${name}\` once to log in before adding an agent`;

/**
 * The installed adapters that report signed out. `detect(name)` resolves truthy
 * when the CLI is installed; `runStatus(name, args)` resolves its exit code, or
 * null when it could not be run (timeout, spawn error), which is not a verdict.
 */
export const signedOutAdapters = async ({ detect, runStatus, env = process.env, names = Object.keys(LOGIN_STATUS_ARGS) }) => {
  const out = [];
  for (const name of names) {
    if (!LOGIN_STATUS_ARGS[name] || (KEY_ENV[name] && env[KEY_ENV[name]])) continue;
    let installed = false;
    try { installed = Boolean(await detect(name)); } catch { /* not installed */ }
    if (!installed) continue;
    const code = await runStatus(name, LOGIN_STATUS_ARGS[name]).catch(() => null);
    if (code === SIGNED_OUT_EXIT) out.push(name);
  }
  return out;
};

// The exit code of `<name> <args>`, with every stream discarded. null when it
// cannot run or takes longer than `timeoutMs` (a CLI that opens a prompt).
export const runLoginStatus = (name, args, { timeoutMs = 10_000, spawnFn = spawn } = {}) => new Promise((done) => {
  let child;
  try {
    child = spawnFn(name, args, { stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
  } catch {
    done(null);
    return;
  }
  const timer = setTimeout(() => { child.kill(); done(null); }, timeoutMs);
  child.on('error', () => { clearTimeout(timer); done(null); });
  child.on('exit', (code) => { clearTimeout(timer); done(typeof code === 'number' ? code : null); });
});
