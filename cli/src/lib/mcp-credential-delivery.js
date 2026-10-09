/**
 * How a declared MCP server receives the seat credential, for the two adapters
 * that cannot hand it over on a pipe.
 *
 * The pi bridge spawns the server itself, so it can pipe the credential on an
 * inherited fd (see `pi-mcp-client.mjs`). Claude and codex do not: each of them
 * starts the server inside its own process tree, so the only two channels
 * available are (a) a value in the runtime's environment, which the whole
 * subtree inherits, or (b) a PATH in the declaration that the server itself
 * reads. (b) is the one that leaves the token where it belongs.
 *
 * This module makes that choice in ONE place, because three call sites deciding
 * version thresholds independently is how one of them ends up handing over the
 * value while the others hand over the path.
 *
 * The rewrite is of the DECLARATION, not of the value: an entry that named
 * `COMMONLY_AGENT_TOKEN` comes back naming `COMMONLY_TOKEN_FILE`, so the value
 * never exists in the runtime's environment to be inherited, logged, or dumped
 * by an unrelated MCP server that a seat was granted.
 */
import { CREDENTIAL_FILE_VAR, CREDENTIAL_KEY } from './credential-file.js';
import {
  FILE_READER_VERSION, MCP_PACKAGE, describeMcpCommand, versionOlderThan,
} from './mcp-server-version.js';

/** What a declaration should say to receive the credential as a path. */
export const CREDENTIAL_FILE_PLACEHOLDER = '${COMMONLY_TOKEN_FILE}';

/**
 * What a runtime's OWN environment may carry, once the declarations are settled.
 *
 * The rewrite above decides what a CHILD is told. It does not decide what the
 * runtime process itself carries, and that is a separate leak with the same
 * symptom: the credential is exported for bootstrap (`agent run`, the daemon),
 * so an adapter that derives its runtime environment from `process.env` hands
 * the value back to the runtime — and to every MCP child, hook and shell below
 * it — however the declaration was rewritten. Measured (Vera, 70455): four tests
 * that pass in a runner without the variable fail with it set, and the value
 * they saw was the runner's own.
 *
 * So the PATH of this spawn's file goes in (a path is not a secret, and a hook
 * process resolves its credential from it — see `hooks-config.resolveHookToken`)
 * and the VALUE comes out, unless a carve-out genuinely needs the value here:
 * a field the adapter substitutes LITERALLY has no file channel, so `keepsValue`
 * is passed in by the adapter rather than inferred, and the spawn that keeps a
 * secret says so in its own warning.
 *
 * The PATH comes out too when there is no file for THIS spawn. The runtime
 * environment is derived from `process.env`, so a launcher whose own process was
 * spawned by another seat inherits that seat's `COMMONLY_TOKEN_FILE` and hands
 * it to the runtime and every MCP child below it — a path to a credential this
 * launcher did not mint. The value was already deleted here for that reason; the
 * path is the same leak with a smaller blast radius.
 */
export const withholdRuntimeCredential = (env, { credentialFile = null, keepsValue = false } = {}) => {
  if (credentialFile) {
    env[CREDENTIAL_FILE_VAR] = credentialFile;
  } else {
    delete env[CREDENTIAL_FILE_VAR];
  }
  if (!keepsValue) delete env[CREDENTIAL_KEY];
  return env;
};

/** What a declaration says when it asks for the seat credential (the old shape). */
export const CREDENTIAL_PLACEHOLDER = '${COMMONLY_AGENT_TOKEN}';

/**
 * Rewrite one server's declared environment so the credential arrives as a path.
 *
 * Returns `{ env, delivered }` where `delivered` is one of:
 *   'path'        — the declaration now names the file; the adapter expands it
 *   'env'         — the value stays in the environment, deliberately (see below)
 *   'none'        — nothing to deliver: the entry declares no credential
 *   'unavailable' — no launcher credential file exists for this spawn
 *
 * `env` is a fresh object; the caller's declaration is never mutated.
 */
export const deliverSeatCredential = (server, {
  credentialFile,
  onWarn = (message) => process.stderr.write(`${message}\n`),
  label = 'mcp',
} = {}) => {
  const env = { ...((server || {}).env || {}) };
  if (env[CREDENTIAL_FILE_VAR] !== undefined && String(env[CREDENTIAL_FILE_VAR]).trim() !== '') {
    // Already on the launcher channel — an operator who set this by hand, or a
    // record written after this shipped. Nothing to rewrite.
    return { env, delivered: 'path' };
  }
  if (env[CREDENTIAL_KEY] === undefined) return { env, delivered: 'none' };
  if (!credentialFile) {
    // No launcher wrote a file, so there is nothing to point at. Leave the
    // declaration exactly as it was rather than handing over a path to nowhere.
    return { env, delivered: 'unavailable' };
  }
  const ours = describeMcpCommand((server || {}).command);
  if (!ours) {
    // Somebody else's server. Their declaration is theirs: we do not know their
    // protocol, so replacing their variable with a path would break a server we
    // have no business redefining.
    onWarn(`[${label}] ${server?.name} is not ${MCP_PACKAGE} but declares ${CREDENTIAL_KEY}; leaving that declaration alone. Declare the seat credential on the commonly entry instead.`);
    return { env, delivered: 'env' };
  }
  if (versionOlderThan(ours.version, FILE_READER_VERSION) === true) {
    // Measured, not hypothetical: five seats run a hand-patched staging checkout
    // at 0.3.7, whose reader only understands the environment. Handing it a path
    // it cannot read would take its tools away rather than its secret.
    onWarn(`[${label}] ${server.name} runs @commonlyai/mcp ${ours.version.join('.')}, which predates the credential file (${FILE_READER_VERSION.join('.')}): keeping the token in the environment. Unpin it, or move that seat off this checkout.`);
    return { env, delivered: 'env' };
  }
  if (String(env[CREDENTIAL_KEY]) !== CREDENTIAL_PLACEHOLDER) {
    // A literal token in a declaration is stale by construction — seat tokens
    // rotate, and this one was read when the record was written. Superseding it
    // with the live credential is a repair, but it IS a change in what the seat
    // sends, so it is said out loud rather than done quietly.
    onWarn(`[${label}] ${server.name} declares a literal ${CREDENTIAL_KEY}; superseding it with this spawn's credential file.`);
  }
  delete env[CREDENTIAL_KEY];
  env[CREDENTIAL_FILE_VAR] = CREDENTIAL_FILE_PLACEHOLDER;
  return { env, delivered: 'path' };
};
