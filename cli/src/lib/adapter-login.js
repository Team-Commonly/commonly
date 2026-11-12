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

// Credentials a seat runs on without a CLI login, so the probe is skipped.
// codex's are the ones codexAuthKind and the proxy route accept (adapters/
// codex.js), even though `codex login status` exits 1 with only a key set.
const KEY_ENV = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
};
const envSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

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
    if (!LOGIN_STATUS_ARGS[name] || (KEY_ENV[name] || []).some((key) => envSet(env, key))) continue;
    let installed = false;
    try { installed = Boolean(await detect(name)); } catch { /* not installed */ }
    if (!installed) continue;
    const code = await runStatus(name, LOGIN_STATUS_ARGS[name]).catch(() => null);
    if (code === SIGNED_OUT_EXIT) out.push(name);
  }
  return out;
};

/**
 * One harness's login, for the daemon's inventory (F458): true signed in (exit
 * 0), false signed out (exit 1), null when there is no verdict: no checked
 * probe for it, a key in the environment it runs on instead, or a probe that
 * couldn't run. Only the exit code is read, as above.
 */
export const loginState = async (name, { runStatus = runLoginStatus, env = process.env } = {}) => {
  if (!LOGIN_STATUS_ARGS[name] || (KEY_ENV[name] || []).some((key) => envSet(env, key))) return null;
  const code = await runStatus(name, LOGIN_STATUS_ARGS[name]).catch(() => null);
  if (code === 0) return true;
  return code === SIGNED_OUT_EXIT ? false : null;
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
