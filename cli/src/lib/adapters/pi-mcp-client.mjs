/**
 * A minimal MCP client for the pi bridge (pi-commonly-mcp.mjs), over both
 * transports the environment spec admits: stdio (newline-delimited JSON-RPC)
 * and Streamable HTTP.
 *
 * A client for four methods (initialize, tools/list, tools/call, the
 * initialized notification) is smaller than a dependency, and keeping it in a
 * file with no pi imports means the CLI's own jest can test it — `typebox`
 * only resolves inside pi's extension loader, so the extension file stays thin
 * and untested by jest.
 *
 * pi itself has no MCP support by design (its README: "No MCP. … build an
 * extension that adds MCP support"); this bridge IS that extension, so an
 * HTTP MCP server reaches a pi seat only through the client below. A
 * `url`-only entry used to be dropped by the two filters here and in pi.js,
 * which is how a granted pi seat ended up holding the grant broker — a
 * Streamable HTTP server — and getting nothing, silently.
 */

import { spawn } from 'node:child_process';
import {
  closeSync, readFileSync, existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CREDENTIAL_FILE_VAR } from '../credential-file.js';

/**
 * The grant broker's path. wren's ruling for the daemon-side half of TASK-063:
 * pi confines on no host — `pi.js assertNoSandboxDeclared` refuses a DECLARED
 * sandbox and nothing ever derives one — so a grant broker must not reach a pi
 * seat by ANY route: not the server's projection (the backend refuses it there
 * too), and not an older backend that still projects it, which is this layer's
 * job. Keyed on the PATH and not on the entry's `name`, because the name is
 * whatever the declaration says while the path is the broker's. A url that does
 * not parse is not this predicate's business — the origin rule in
 * `pi.js resolveMcpServers` refuses those before they are carried.
 */
export const GRANT_BROKER_PATH = '/api/mcp/grants/';

/**
 * The reason string BOTH halves of this refusal use, verbatim from the server's
 * typed refusal (`backend/services/grantBrokerConfinement.ts`: code
 * `grant_broker_unconfined`, reason `adapter_cannot_confine`). wren's ruling
 * (69829): "Same reason string on both halves" — so a daemon log line and the
 * server's `grantBrokerRefusal` field can be read side by side, and neither
 * layer grows a vocabulary the other one does not have. Mirrored rather than
 * imported: this package does not depend on the backend, so the literal is
 * pinned by a test instead.
 */
export const GRANT_BROKER_REFUSAL = 'grant_broker_unconfined: adapter_cannot_confine';

/**
 * Is this url the instance's grant broker? Path-keyed, and the comparison is
 * case-INSENSITIVE because the route it mirrors is: express matches paths
 * case-insensitively unless `caseSensitive` is set, so the live API answers
 * `/API/MCP/GRANTS/x` from the same handler as `/api/mcp/grants/x` (measured
 * 2026-09-19: POST both → 401, POST `/api/nothing/x` → 404, i.e. the control is
 * what distinguishes a matched route from a missing one). A case-sensitive
 * predicate therefore refuses the spelled-canonically broker and hands pi the
 * uppercased spelling of it — the real runtime token included. Vera measured
 * exactly that against the running instance (69839).
 *
 * Case is the only spelling the router forgives: `%67rants`, `//`, `./` and
 * `GRANTS%2F` all 404 on the live API, and a trailing slash is already inside
 * the prefix.
 */
export const isGrantBrokerUrl = (url) => {
  try {
    return new URL(url).pathname.toLowerCase().startsWith(GRANT_BROKER_PATH);
  } catch {
    return false;
  }
};

const PROTOCOL_VERSION = '2024-11-05';
const MAX_TEXT = 50 * 1024;

const truncate = (text) => (text.length <= MAX_TEXT
  ? text
  : `${text.slice(0, MAX_TEXT)}\n… [truncated ${text.length - MAX_TEXT} bytes]`);

/**
 * Connect to one declared server, stdio or Streamable HTTP. `resolveMcpServers`
 * emits exactly one of `command`/`url` per entry, and `readServers` keeps that
 * invariant, so the shape decides; `url` wins if a hand-built entry still
 * carries both, because a server that advertises an endpoint is not a command
 * to spawn.
 */
export const connectMcp = (server, opts = {}) => (typeof server?.url === 'string' && server.url
  ? connectHttpMcp(server, opts)
  : connectStdioMcp(server, opts));

/**
 * The credential channel (TASK-078, ruled 2026-09-19: "take the token out of
 * the environment", inherited pipe).
 *
 * `connectStdioMcp` spawns each declared stdio server with
 * `{...process.env, ...env}`, and the default declaration puts the seat's
 * runtime token in that `env` map. So the token sat in the MCP child's
 * environment, where any same-user process could read it back with
 * `ps eww <pid>` or `/proc/<pid>/environ` — including, on a shared host, a
 * process the seat is not allowed to talk to.
 *
 * Now the token rides an inherited pipe on fd 3 and the child's environment
 * carries only a pointer to it (`COMMONLY_TOKEN_FD=3`) — not a secret. The
 * child end of that pipe is read to EOF.
 *
 * WHERE THE TOKEN COMES FROM. The launcher writes a per-spawn 0600 file and the
 * declaration names it with `${COMMONLY_TOKEN_FILE}` — a PATH, not a secret — so
 * the runtime's own environment never holds the token (TASK-082/083). A
 * declaration that instead carries the literal token in `COMMONLY_AGENT_TOKEN`
 * still works: that is the older channel, and it is the operator's to declare.
 * Whichever named the credential, the child gets it on the pipe and its own
 * environment is left clean.
 *
 * THE PIPE IS ONLY AVAILABLE WHERE WE SPAWN. This is the pi path; claude and
 * codex let their own CLI start the server (claude expands `${VAR}` in its own
 * process env, codex writes a plain `mcp_servers.*.env` entry), so a pipe opened
 * here never reaches that grandchild. Those two deliver the PATH instead, which
 * is what let the token leave their runtime environments too.
 *
 * THE OLD SERVER STILL WORKS. `@commonlyai/mcp` only learned to read the pipe in
 * 0.3.11, and a seat may pin an older one — the five staging seats ran a checkout
 * of 0.3.7 when this was measured (2026-09-19; the doc here said 0.3.4, which was
 * true two weeks earlier) — so a declaration whose command names an older
 * `@commonlyai/mcp` keeps the environment variable AS WELL, with a warning that
 * names the pin. An operator can also opt out explicitly with
 * `COMMONLY_TOKEN_CHANNEL=env` in the entry's own env. Otherwise the token is
 * piped and the environment is left clean.
 */
export const CREDENTIAL_KEY = 'COMMONLY_AGENT_TOKEN';
export const CREDENTIAL_FD_VAR = 'COMMONLY_TOKEN_FD';
export const CREDENTIAL_CHANNEL_VAR = 'COMMONLY_TOKEN_CHANNEL';
export const CREDENTIAL_FD = 3;

/**
 * The only variables a spawned MCP server inherits from us.
 *
 * This list is DERIVED, not guessed: each entry exists because a real child
 * failed without it, and a child that only fails at spawn is the worst failure
 * shape there is (TASK-083). `PATH` runs the command (and, for a seat, carries
 * the seat-launch shim directory prepended, so it must be passed through rather
 * than canonicalised); `HOME` is where `npx` keeps the cache it fetches
 * `@commonlyai/mcp` into, which a cold start needs; `TMPDIR` was measured in a
 * live child on macOS, where /var/folders is not /tmp; the proxy and CA names
 * are absent on this machine, so an operator behind a proxy or a private CA is
 * the case that cannot be exercised here — including them unset costs nothing,
 * and without them that operator's cold `npx` would fail in a way that reads as
 * this change regressing.
 *
 * Deliberately NOT a prefix match: a variable named `COMMONLY_*` is ours to hand
 * over explicitly, and a variable named like a secret is exactly what an
 * allowlist exists to drop.
 */
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * The environment a spawned MCP server gets: the allowlist above, then whatever
 * the entry itself declared, and nothing else. The daemon's environment is not a
 * channel into a child — `...process.env` used to make it one, which is how a
 * third-party server came to hold our seat token and the model key.
 */
export const buildChildEnv = (parentEnv, declaredEnv) => {
  const out = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parentEnv ? parentEnv[key] : undefined;
    if (value !== undefined) out[key] = value;
  }
  return Object.assign(out, declaredEnv || {});
};

/** The `@commonlyai/mcp` release whose `loadConfig` reads the pipe channel. */
export const PIPE_READER_VERSION = [0, 3, 11];

const MCP_PACKAGE = '@commonlyai/mcp';

const parseVersion = (spec) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(spec || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const olderThanPipeReader = (version) => {
  if (!version) return null;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== PIPE_READER_VERSION[i]) return version[i] < PIPE_READER_VERSION[i];
  }
  return false;
};

/**
 * What an `@commonlyai/mcp` command would run, or null when the command cannot
 * be identified as that package at all.
 *
 * Two shapes matter: `npx [-y] @commonlyai/mcp@<spec>` (a spec is a version, or
 * `latest`/absent, which resolves to whatever is published — never treated as
 * old), and a local checkout, `node <path>/src/index.js`, which is what the
 * staging seats run; for that one the package.json beside it is the only honest
 * answer, and a package.json naming something else means this is not our server.
 *
 * `{ isCommonly: true, version: null }` means "our server, version unknown" —
 * an unpinned npx spec, whose whole point is that it tracks the published one.
 * `null` as the return value means "not identifiable as our server", which is a
 * different answer and takes a different branch: a stranger's server gets its
 * declaration honoured unchanged.
 */
export const describeMcpCommand = (command, { readTextFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null) } = {}) => {
  if (!Array.isArray(command) || command.length === 0) return null;
  const parts = command.map(String);
  const pkgArg = parts.find((p) => p.includes(MCP_PACKAGE));
  if (pkgArg) {
    const at = pkgArg.lastIndexOf('@');
    if (at <= pkgArg.indexOf(MCP_PACKAGE)) return { isCommonly: true, version: null };
    return { isCommonly: true, version: parseVersion(pkgArg.slice(at + 1)) };
  }
  const scriptPath = parts.find((p) => p.endsWith('.js') || p.endsWith('.mjs'));
  if (!scriptPath) return null;
  // `src/index.js` → `../package.json`; also try one level further up, because a
  // bin shim can live in `bin/` beside `src/`.
  for (const candidate of [join(dirname(scriptPath), '..', 'package.json'), join(dirname(scriptPath), 'package.json')]) {
    let raw;
    try {
      raw = readTextFile(candidate);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const pkg = JSON.parse(raw);
      if (!pkg || typeof pkg !== 'object') continue;
      if (pkg.name === MCP_PACKAGE) return { isCommonly: true, version: parseVersion(pkg.version) };
      // A package.json that names another package settles it: not ours, so its
      // declaration is none of this function's business.
      return null;
    } catch {
      // A malformed package.json is not an answer; keep looking.
    }
  }
  return null;
};

/**
 * Split a declared env map into the child's environment and the credential to
 * hand over the pipe.
 *
 * Returns `{ env, credential, keepInEnv }`. `keepInEnv` is true only when the
 * server cannot read the pipe — it predates the reader, it is somebody else's
 * server, or the declaration opted out explicitly. Everything else gets the
 * pointer variable and no secret.
 */
export const splitCredential = (env, command, {
  onWarn = (m) => process.stderr.write(`${m}\n`),
  readCredentialFile = (path) => readFileSync(path, 'utf8'),
} = {}) => {
  const declared = { ...(env || {}) };
  const declaredFile = declared[CREDENTIAL_FILE_VAR];
  const requested = String(declared[CREDENTIAL_CHANNEL_VAR] || '').trim().toLowerCase();
  delete declared[CREDENTIAL_CHANNEL_VAR];
  let credential = null;
  let fromFile = false;
  // A declaration that names a file is using the launcher channel, and that is
  // the one to honour: if it ALSO carries a literal token, the literal is the
  // leftover of an older declaration, and preferring it would keep the secret in
  // the very place this exists to empty.
  if (declaredFile !== undefined && String(declaredFile).trim() !== '') {
    // The launcher channel: the declaration names a path, and the credential is
    // read here so the child never needs the file (or the token) at all.
    const path = String(declaredFile).trim();
    let raw;
    try {
      raw = readCredentialFile(path);
    } catch (err) {
      throw new Error(`the declared credential file could not be read: ${path}: ${err.message}`);
    }
    credential = String(raw ?? '').trim();
    if (!credential) throw new Error(`the declared credential file carried nothing: ${path}`);
    fromFile = true;
  } else if (declared[CREDENTIAL_KEY]) {
    credential = declared[CREDENTIAL_KEY];
  }
  if (!credential) {
    delete declared[CREDENTIAL_KEY];
    delete declared[CREDENTIAL_FILE_VAR];
    return { env: declared, credential: null, keepInEnv: false };
  }
  if (requested === 'env') {
    declared[CREDENTIAL_KEY] = credential;
    delete declared[CREDENTIAL_FILE_VAR];
    return { env: declared, credential: null, keepInEnv: true };
  }
  const server = describeMcpCommand(command);
  if (!server) {
    // Not identifiable as @commonlyai/mcp. A declaration that put this key in a
    // stranger's environment asked for it to be there, and that server has no
    // reason to know about a pipe; changing its contract is not this change's
    // business.
    return { env: declared, credential: null, keepInEnv: true };
  }
  if (server.version && olderThanPipeReader(server.version) === true) {
    onWarn(`[pi-mcp-client] ${command[0]} runs ${MCP_PACKAGE} ${server.version.join('.')}, which predates the pipe channel (0.3.11): keeping the token in the child environment. Unpin it, or set ${CREDENTIAL_CHANNEL_VAR}=env to say so on purpose.`);
    declared[CREDENTIAL_KEY] = credential;
    delete declared[CREDENTIAL_FILE_VAR];
    return { env: declared, credential: null, keepInEnv: true };
  }
  delete declared[CREDENTIAL_KEY];
  // The pipe carries the credential, so the child needs neither the token nor the
  // path: one declared channel, and it is the fd.
  delete declared[CREDENTIAL_FILE_VAR];
  declared[CREDENTIAL_FD_VAR] = String(CREDENTIAL_FD);
  return { env: declared, credential, keepInEnv: false, fromFile };
};

/** A minimal MCP stdio client: initialize, tools/list, tools/call. */
export const connectStdioMcp = ({
  name, command, env,
}, {
  spawnImpl = spawn, timeoutMs = 60_000, onWarn, parentEnv = process.env, readCredentialFile,
} = {}) => {
  const [cmd, ...args] = command;
  const opts = onWarn ? { onWarn } : {};
  if (readCredentialFile) opts.readCredentialFile = readCredentialFile;
  const { env: declaredEnv, credential, keepInEnv } = splitCredential(env, command, opts);
  // The child gets an ALLOWLIST plus its own declaration — never the daemon's
  // environment. `...process.env` is what let a third-party MCP server inherit
  // both the seat token and the model key (TASK-083).
  const childEnv = buildChildEnv(parentEnv, declaredEnv);
  if (!keepInEnv) delete childEnv[CREDENTIAL_KEY];
  const stdio = credential ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  const proc = spawnImpl(cmd, args, { env: childEnv, stdio });
  if (credential) {
    const channel = proc.stdio && proc.stdio[CREDENTIAL_FD];
    if (!channel) {
      // Fail loudly rather than fall back: the environment it would fall back to
      // is the thing this change exists to empty.
      throw new Error(`${name}: no fd ${CREDENTIAL_FD} pipe to carry the runtime token`);
    }
    channel.on('error', () => {});
    channel.end(credential);
  }
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = msg && msg.id !== undefined ? pending.get(msg.id) : null;
      if (!waiter) continue;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(`${name}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else waiter.resolve(msg.result);
    }
  });
  proc.on('exit', (code) => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${name}: MCP server exited (${code}) before answering`));
    }
  });
  const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}: ${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params: params || {} });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params: params || {} });
  const initialize = async () => {
    const result = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'commonly-pi-bridge', version: '1.0.0' },
    });
    notify('notifications/initialized');
    return result;
  };
  const listTools = async () => (await request('tools/list')).tools || [];
  const callTool = (toolName, args) => request('tools/call', { name: toolName, arguments: args || {} });
  const close = () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };
  return { initialize, listTools, callTool, close, proc };
};

/**
 * Split an SSE body into its `data:` payloads. Streamable HTTP lets a server
 * answer a POST either with one JSON object or with an event stream holding
 * the JSON-RPC messages, so both shapes are parsed.
 */
const ssePayloads = (text) => text.split(/\r?\n\r?\n/)
  .map((block) => block.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n'))
  .filter(Boolean);

const parseMessages = (text, contentType) => {
  const body = text.trim();
  if (!body) return [];
  if (contentType.includes('text/event-stream')) return ssePayloads(body);
  // A server MAY answer a request with plain JSON regardless of the request's
  // `accept`, so the body decides before the header does.
  if (body.startsWith('{') || body.startsWith('[')) return [body];
  return ssePayloads(body);
};

/**
 * A minimal MCP Streamable HTTP client: initialize, tools/list, tools/call.
 *
 * `headers` is where a declared `Authorization` arrives, already substituted
 * with the seat's runtime token by the adapter. The token therefore rides in an
 * HTTP header built from the JSON list the bridge reads off its own fd 3 (see
 * takeServers) — never on argv, and never in this process's environment, which a
 * same-user child of this process can read back whole (`ps eww $PPID`,
 * `/proc/$PPID/environ`) no matter what this process deletes from its own copy.
 */
export const connectHttpMcp = ({ name, url, headers }, { fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) => {
  if (typeof fetchImpl !== 'function') throw new Error(`${name}: no fetch implementation for the HTTP MCP transport`);
  const declared = headers || {};
  let nextId = 1;
  let sessionId = null;
  let protocolVersion = PROTOCOL_VERSION;
  let negotiated = false;
  const requestHeaders = () => ({
    'content-type': 'application/json',
    // Both, per the spec: a server may answer with JSON or with an event stream.
    accept: 'application/json, text/event-stream',
    ...declared,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    // The version header follows NEGOTIATION, not the session. Our own broker is
    // stateless (`mcpGrants.ts` sets `sessionIdGenerator: undefined`), so it
    // never mints a session id — gating this on one meant the only broker we
    // have never received the version it negotiated (Vera, Connectors).
    ...(negotiated ? { 'mcp-protocol-version': protocolVersion } : {}),
  });
  const post = async (payload) => {
    const controller = new AbortController();
    let timer;
    // Race an explicit timer as well as aborting: a client whose fetch ignores
    // the signal must not leave a seat waiting forever on a dead endpoint.
    const expired = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${name}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([fetchImpl(url, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
        // These requests carry the seat token in a header. A redirect is
        // allowed to point at another origin, and whether undici strips an
        // Authorization header when it follows one is not something a seat may
        // rely on — so no redirect is followed at all.
        redirect: 'error',
      }), expired]);
      const text = await res.text();
      const header = res.headers?.get?.('mcp-session-id');
      if (header && !sessionId) sessionId = header;
      return { res, text, contentType: res.headers?.get?.('content-type') || '' };
    } catch (error) {
      if (error?.message?.startsWith(`${name}:`)) throw error;
      throw new Error(`${name}: ${error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : `${payload?.method || 'request'} failed: ${error?.message || error}`}`);
    } finally {
      clearTimeout(timer);
    }
  };
  const request = async (method, params) => {
    const id = nextId++;
    const { res, text, contentType } = await post({ jsonrpc: '2.0', id, method, params: params || {} });
    if (!res.ok) throw new Error(`${name}: ${method} failed with HTTP ${res.status}${text ? `: ${truncate(text)}` : ''}`);
    const messages = parseMessages(text, contentType)
      .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(Boolean);
    const answer = messages.find((m) => m.id === id);
    if (!answer) throw new Error(`${name}: ${method} returned no JSON-RPC answer (HTTP ${res.status})`);
    if (answer.error) throw new Error(`${name}: ${answer.error.message || JSON.stringify(answer.error)}`);
    return answer.result;
  };
  const notify = async (method, params) => {
    const { res, text } = await post({ jsonrpc: '2.0', method, params: params || {} });
    // The spec answers a notification with 202 and no body; anything else is
    // an error the seat should see rather than a silent drop.
    if (!res.ok) throw new Error(`${name}: ${method} failed with HTTP ${res.status}${text ? `: ${truncate(text)}` : ''}`);
  };
  const initialize = async () => {
    const result = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'commonly-pi-bridge', version: '1.0.0' },
    });
    // The server's answer is authoritative; echo what it negotiated from here on.
    if (result && typeof result.protocolVersion === 'string') protocolVersion = result.protocolVersion;
    negotiated = true;
    await notify('notifications/initialized');
    return result;
  };
  const listTools = async () => (await request('tools/list')).tools || [];
  const callTool = (toolName, args) => request('tools/call', { name: toolName, arguments: args || {} });
  const close = () => {
    if (!sessionId) return;
    try {
      const pending = fetchImpl(url, { method: 'DELETE', headers: requestHeaders(), redirect: 'error' });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* best effort: the session expires on its own */ }
  };
  return { initialize, listTools, callTool, close, sessionId: () => sessionId };
};

/** MCP `{ content, isError }` → pi tool result. Non-text parts are named, not dropped silently. */
export const toPiResult = (result) => {
  const parts = (result?.content || []).map((c) => (c?.type === 'text' ? String(c.text ?? '') : `[${c?.type || 'content'} omitted]`));
  const text = truncate(parts.join('\n'));
  return { content: [{ type: 'text', text: result?.isError ? `error: ${text}` : text }], details: { isError: !!result?.isError } };
};

/**
 * Read the server list off the inherited pipe on `fd` and CONSUME it.
 *
 * The list carries every server's substituted secrets — a stdio server's env and
 * an HTTP server's `Authorization` header, the seat's bearer token among them —
 * and pi's `bash` tool spawns with `{ ...process.env }` (pi's getShellEnv), so it
 * has to arrive by a channel pi's children do not inherit and must not outlive
 * the read. It arrives here as fd 3: a pipe the adapter writes the JSON into and
 * ends at spawn (pi.js runPi). This reads it to EOF and closes the descriptor.
 *
 * WHY NOT THE ENVIRONMENT, which is what this replaced: deleting the variable
 * scrubbed Node's copy only, while the kernel keeps the environment this process
 * was STARTED with, so a same-user child still read the token back with
 * `ps eww $PPID` on macOS and `/proc/$PPID/environ` on Linux. Unsetting it at
 * spawn cannot help either, because this runs inside the pi process that holds
 * it. WHY NOT a 0600 file the bridge unlinks on load: the mode protects nothing
 * against a same-user reader, and that shape needs both the unlink and a close
 * to leave no window, since `/proc/<pid>/fd` on Linux still reaches an unlinked
 * inode. A pipe has neither a path nor a stored copy.
 *
 * THE READ IS WHAT REMOVES THE SECRET, not the close: a pipe is consumed, so a
 * second reader gets nothing. Measured against pi 0.84.1 — after a read to EOF
 * a second read of the same descriptor returned zero bytes, while a 5-byte
 * partial read left the remainder readable. Closing afterwards is hygiene.
 *
 * Two further measurements this rests on, both against pi 0.84.1: pi does not
 * close inherited descriptors before loading extensions, so fd 3 is still open
 * here (this runs at extension load, before the first model turn — and before
 * any bash tool can run); and pi's own spawns (`dist/core/tools/bash.js`,
 * `dist/core/exec.js`) pass a THREE-element stdio list, so a shell tool child
 * does not inherit fd 3 at all.
 *
 * An unreadable descriptor yields no servers rather than throwing: a seat whose
 * bridge cannot read its list should run without Commonly tools, not fail to
 * start. The bridge logs that empty result (pi-commonly-mcp.mjs).
 *
 * The descriptor is closed only after a successful read, and that is not
 * tidiness: on macOS, `closeSync` on the descriptor Node opens for an `'ignore'`
 * stdio entry aborts the process — measured 2026-09-19, Node 20 — with
 * `Assertion failed: (errno == EINTR), function uv__io_poll, file kqueue.c`,
 * where the read itself had already failed harmlessly with `ENXIO`. A close in
 * `finally` therefore turns "no channel" into a SIGABRT in the seat.
 */
export const takeServers = (fd = 3) => {
  let raw = null;
  try {
    raw = readFileSync(fd, 'utf8');
  } catch {
    // Nothing to close: the read failed, so this was not a descriptor we consumed.
    return [];
  }
  try { closeSync(fd); } catch { /* already closed */ }
  return readServers(raw);
};

/**
 * Entries with a non-empty `command` and no `url` are stdio; entries with a
 * non-empty `url` and no `command` are Streamable HTTP. The two are mutually
 * exclusive on purpose: `resolveMcpServers` emits exactly one field per entry
 * (the transport decides which), so an entry carrying BOTH did not come from it
 * and is dropped rather than spawned — the adapter is the layer that executes,
 * and a shape it cannot classify is not one it should run. Both the adapter
 * (pi.js resolveMcpServers) and this filter have to agree, or a server reaches
 * the bridge as an unstartable entry.
 */
export const isStdioServer = (s) => Array.isArray(s?.command) && s.command.length > 0
  && !(typeof s?.url === 'string' && s.url.length > 0);
export const isHttpServer = (s) => typeof s?.url === 'string' && s.url.length > 0
  && !(Array.isArray(s?.command) && s.command.length > 0);

export const readServers = (raw) => {
  if (!raw) return [];
  try {
    // The broker is dropped here as well as in pi.js (same reason string, see
    // GRANT_BROKER_REFUSAL): this is the last layer before a client is started,
    // and the two filters have to agree or a server reaches the bridge as an
    // entry the adapter would not have carried.
    return JSON.parse(raw).filter((s) => s?.name
      && (isStdioServer(s) || (isHttpServer(s) && !isGrantBrokerUrl(s.url))));
  } catch { return []; }
};

