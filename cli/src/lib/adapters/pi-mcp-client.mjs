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

const PROTOCOL_VERSION = '2024-11-05';
const MAX_TEXT = 50 * 1024;

const truncate = (text) => (text.length <= MAX_TEXT
  ? text
  : `${text.slice(0, MAX_TEXT)}\n… [truncated ${text.length - MAX_TEXT} bytes]`);

/**
 * Connect to one declared server, stdio or Streamable HTTP. The adapter's
 * `resolveMcpServers` emits exactly one of `command`/`url` per entry; `url`
 * wins if a malformed entry somehow carries both, because a server that
 * advertises an endpoint is not a command to spawn.
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
 * with the seat's runtime token by the adapter. The token therefore rides in
 * an HTTP header built from the JSON list the bridge takes out of its own
 * environment (see takeServers) — never on argv, and never left where pi's
 * bash tool could print it.
 */
export const connectHttpMcp = ({ name, url, headers }, { fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) => {
  if (typeof fetchImpl !== 'function') throw new Error(`${name}: no fetch implementation for the HTTP MCP transport`);
  const declared = headers || {};
  let nextId = 1;
  let sessionId = null;
  let protocolVersion = PROTOCOL_VERSION;
  const requestHeaders = () => ({
    'content-type': 'application/json',
    // Both, per the spec: a server may answer with JSON or with an event stream.
    accept: 'application/json, text/event-stream',
    ...declared,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(sessionId ? { 'mcp-protocol-version': protocolVersion } : {}),
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
    await notify('notifications/initialized');
    return result;
  };
  const listTools = async () => (await request('tools/list')).tools || [];
  const callTool = (toolName, args) => request('tools/call', { name: toolName, arguments: args || {} });
  const close = () => {
    if (!sessionId) return;
    try {
      const pending = fetchImpl(url, { method: 'DELETE', headers: requestHeaders() });
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
 * Read the server list and REMOVE it from the environment. The list carries every
 * server's substituted secrets — a stdio server's env and an HTTP server's
 * `Authorization` header, the seat's bearer token among them — and pi's `bash`
 * tool spawns with `{ ...process.env }` (pi's getShellEnv), so leaving it in place
 * lets one `env` from the model print the token. The clients already hold what
 * they need from spawn time; nothing else reads this variable.
 */
export const takeServers = (env = process.env) => {
  const servers = readServers(env.COMMONLY_PI_MCP);
  delete env.COMMONLY_PI_MCP;
  return servers;
};

/**
 * Entries with a non-empty `command` are stdio; entries with a `url` are
 * Streamable HTTP. Anything with neither is not a server and is dropped. Both
 * the adapter (pi.js resolveMcpServers) and this filter have to agree, or a
 * server reaches the bridge as an unstartable entry.
 */
export const isStdioServer = (s) => Array.isArray(s?.command) && s.command.length > 0;
export const isHttpServer = (s) => typeof s?.url === 'string' && s.url.length > 0;

export const readServers = (raw) => {
  if (!raw) return [];
  try { return JSON.parse(raw).filter((s) => s?.name && (isStdioServer(s) || isHttpServer(s))); } catch { return []; }
};

