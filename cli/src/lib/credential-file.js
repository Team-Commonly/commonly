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
 * The caller names the root; this module never invents one, because the only
 * root it could invent is a directory no adapter cleans up.
 *
 * The reader side is `readToken` in `commonly-mcp/src/client.js`, which resolves
 * fd, then file, then environment — by declaration, and refuses to fall through
 * from a declared source that cannot be read.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The variable a child reads to find the credential. Never carries the token. */
export const CREDENTIAL_FILE_VAR = 'COMMONLY_TOKEN_FILE';

/**
 * The variable that USED to carry the token itself, and still does for a server
 * that cannot read anything else. Kept beside the file var so the two channels
 * are named in one place rather than one per adapter.
 */
export const CREDENTIAL_KEY = 'COMMONLY_AGENT_TOKEN';

/**
 * Write `token` to a fresh 0600 file under `root` and return its path, or null
 * when there is no token to write (a seat bootstrapping without one).
 *
 * `root` is REQUIRED. It used to default to the CLI's own state directory, which
 * meant a caller that forgot it wrote a live credential into
 * `~/.commonly/credentials` — a directory no adapter cleans, because that is not
 * where adapters put theirs. Measured 2026-09-20: 32 such directories on the
 * fleet host, 24 of them written by this repo's own harnesses, all holding a
 * seat credential. A missing root is now an error instead of a silent write into
 * the operator's home. The token check stays first, so "no token, nothing
 * written" remains true without a root.
 *
 * `fs` is injectable so tests can assert the mode and the path shape without
 * writing into the operator's home.
 */
export const writeCredentialFile = (token, {
  agentName = 'agent',
  root,
  fs = { mkdirSync, writeFileSync, chmodSync, rmSync },
  now = () => Date.now(),
  random = () => randomBytes(4).toString('hex'),
} = {}) => {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) return null;
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error(
      'writeCredentialFile requires an explicit root: an omitted root used to fall back to '
      + '~/.commonly/credentials, where nothing sweeps the credential files it writes',
    );
  }
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
