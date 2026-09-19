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
import { closeSync, readFileSync } from 'node:fs';

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

/** A minimal MCP stdio client: initialize, tools/list, tools/call. */
export const connectStdioMcp = ({ name, command, env }, { spawnImpl = spawn, timeoutMs = 60_000 } = {}) => {
  const [cmd, ...args] = command;
  const proc = spawnImpl(cmd, args, { env: { ...process.env, ...(env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
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

