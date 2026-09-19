/**
 * A per-spawn credential file: the launcher channel for the runtime token
 * (TASK-082/083, ruled 2026-09-19 — "a credential file, only its PATH in the
 * env").
 *
 * WHY A FILE AND NOT THE ENVIRONMENT. The token used to ride the runtime's own
 * environment (claude expands `${COMMONLY_AGENT_TOKEN}` from it, codex forwards
 * it through `mcp_servers.*.env_vars`), which means every child of the runtime
 * inherited it — measured on 2026-09-19: a `@playwright/mcp` process held the
 * seat's `COMMONLY_AGENT_TOKEN`, and a pi seat's MCP child held the daemon's
 * `COMMONLY_LITELLM_KEY`. A PATH is not a secret, so handing the path to the
 * runtime is safe even though the token it names is not, and an unrelated MCP
 * server that inherits the runtime's environment gets nothing it can use.
 *
 * WHY PER SPAWN. The file lives only as long as one spawn of one runtime, in a
 * directory only its owner can traverse (0700), with the file itself 0600. A
 * fixed path would widen the window to "since the first spawn" and would let two
 * concurrent seats share one credential by accident.
 *
 * The reader side is `readToken` in `commonly-mcp/src/client.js`, which resolves
 * fd, then file, then environment — by declaration, and refuses to fall through
 * from a declared source that cannot be read.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

/** The variable a child reads to find the credential. Never carries the token. */
export const CREDENTIAL_FILE_VAR = 'COMMONLY_TOKEN_FILE';

/** Default root: inside the CLI's own state directory, not a world-readable /tmp. */
export const credentialRoot = () => join(homedir(), '.commonly', 'credentials');

/**
 * Write `token` to a fresh 0600 file and return its path, or null when there is
 * no token to write (a seat bootstrapping without one).
 *
 * `fs` is injectable so tests can assert the mode and the path shape without
 * writing into the operator's home.
 */
export const writeCredentialFile = (token, {
  agentName = 'agent',
  root = credentialRoot(),
  fs = { mkdirSync, writeFileSync, chmodSync, rmSync },
  now = () => Date.now(),
  random = () => randomBytes(4).toString('hex'),
} = {}) => {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return null;
  const dir = join(root, `${agentName}-${now()}-${random()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'token');
  fs.writeFileSync(path, value, { mode: 0o600 });
  // writeFileSync's mode is subject to the process umask, so a 0022 umask still
  // produces 0644. chmod is the assertion, not a courtesy.
  fs.chmodSync(path, 0o600);
  return { path, dir };
};

/** Best-effort removal once the spawn that owns the file has ended. */
export const removeCredentialFile = (written, { fs = { rmSync } } = {}) => {
  const dir = typeof written === 'string' ? dirname(written) : written?.dir;
  if (!dir) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};
