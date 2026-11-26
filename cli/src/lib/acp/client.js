/**
 * A minimal Agent Client Protocol (ACP) client: JSON-RPC 2.0 over a child's
 * stdio, with no dependencies. The `acp` adapter builds its turns on it.
 *
 * Wire format, verified 2026-11-26 against:
 *   https://agentclientprotocol.com/protocol/transports
 *     stdio: each message is one JSON-RPC request, notification or response,
 *     delimited by "\n", and MUST NOT contain embedded newlines; the agent MUST
 *     NOT write anything else to stdout (logs go to stderr). UTF-8.
 *   https://agentclientprotocol.com/protocol/initialization
 *     `initialize` params { protocolVersion, clientCapabilities: { fs:
 *     { readTextFile, writeTextFile }, terminal, auth: { terminal } },
 *     clientInfo }; protocolVersion is a single integer MAJOR version, 1 today.
 *   https://agentclientprotocol.com/protocol/overview and
 *   https://agentclientprotocol.com/protocol/prompt-turn
 *     method names: agent side initialize, authenticate, session/new,
 *     session/load, session/prompt, session/set_mode, notification
 *     session/cancel; client side session/request_permission, the
 *     session/update notification, fs/*, terminal/*.
 *   https://agentclientprotocol.com/protocol/v1/error
 *     codes in ACP_ERROR below; an unknown inbound method gets -32601, and a
 *     notification never gets a response.
 *   https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json
 *   and schema/v1/meta.json beside it: ProtocolVersion is an integer (uint16),
 *   meta.json "version": 1; RequestId is a string, number or null.
 *
 * Nothing here logs params or results: they can carry prompts, file contents
 * and credentials. Logs name known methods, numeric ids and sizes only; any
 * other text the agent chose is logged by type and size.
 */

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

// A file read or a long transcript can be large; a runaway stdout cannot be
// allowed to grow the buffer without bound.
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;

const localError = (code, message) => Object.assign(new Error(message), { code });
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
// An inbound request may also carry a null id (ACP's RequestId allows it);
// the reply echoes it.
const isRequestId = (id) => id === null || isId(id);
// The methods ACP defines. Only these are logged by name: an unknown method,
// like a string id, is text the agent chose, and a log is no place for it.
const KNOWN_METHODS = new Set([
  'initialize', 'authenticate', 'session/new', 'session/load', 'session/prompt',
  'session/cancel', 'session/set_mode', 'session/update', 'session/request_permission',
  'fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output',
  'terminal/release', 'terminal/wait_for_exit', 'terminal/kill',
]);
const sizeLabel = (value) => (typeof value === 'string' ? `${value.length} chars` : typeof value);
const logMethod = (method) => (KNOWN_METHODS.has(method) ? method : `unknown method (${sizeLabel(method)})`);
// Numbers are ours or harmless; any other id is logged by type and size only.
const logId = (id) => {
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (id === null) return 'null';
  return `string, ${sizeLabel(id)}`;
};
// Encoding can fail on a BigInt or a cycle; that failure belongs to the one
// call that brought the value, never to the connection.
const encode = (message) => {
  try {
    return `${JSON.stringify(message)}\n`;
  } catch (err) {
    throw localError('ACP_ENCODE', `ACP message could not be encoded as JSON (${err.name})`);
  }
};

/**
 * Errors from the remote side carry its JSON-RPC `code` (a number), `message`
 * and `data`. Local failures use string codes: ACP_TIMEOUT, ACP_CLOSED.
 */
export function createAcpConnection({
  stdin,
  stdout,
  onNotification = () => {},
  onRequest,
  log = () => {},
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
} = {}) {
  if (!stdin || !stdout) throw new TypeError('createAcpConnection needs the child stdin and stdout');

  const pending = new Map(); // id -> { method, resolve, reject, timer }
  let nextId = 0;
  let closedReason = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  // `line` comes from encode(): JSON.stringify escapes every newline inside
  // strings, so it is exactly one line.
  const write = (line) => {
    if (closedReason !== null) return false;
    try {
      stdin.write(line);
      return true;
    } catch (err) {
      close(`agent stdin write failed: ${err.code || err.name}`);
      return false;
    }
  };

  const close = (reason = 'closed') => {
    if (closedReason !== null) return;
    closedReason = String(reason);
    log(`acp: connection closed (${closedReason}); rejecting ${pending.size} pending`);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(localError('ACP_CLOSED', `ACP connection closed before ${entry.method} (id ${id}) was answered: ${closedReason}`));
    }
    pending.clear();
    stdout.off('data', onData);
    stdout.off('end', onEnd);
    stdout.off('close', onEnd);
    // The error listeners stay: an EPIPE after close must not become an
    // unhandled 'error' event that takes the whole connector down.
    resolveClosed(closedReason);
  };

  const request = (method, params, { timeoutMs } = {}) => {
    if (closedReason !== null) {
      return Promise.reject(localError('ACP_CLOSED', `ACP connection is closed (${closedReason}); ${method} not sent`));
    }
    const id = nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    let line;
    try {
      line = encode(message);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const entry = { method, resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          log(`acp: ${method} (id ${id}) timed out after ${timeoutMs}ms`);
          reject(localError('ACP_TIMEOUT', `ACP request ${method} (id ${id}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      pending.set(id, entry);
      log(`acp: -> ${method} (id ${id})`);
      write(line);
    });
  };

  const notify = (method, params) => {
    if (closedReason !== null) return;
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    if (write(encode(message))) log(`acp: -> ${method} (notification)`);
  };

  const respond = (id, payload) => {
    if (closedReason !== null) return;
    let line;
    try {
      line = encode({ jsonrpc: '2.0', id, ...payload });
    } catch {
      log(`acp: reply to request id ${logId(id)} could not be encoded; sending an internal error`);
      line = encode({ jsonrpc: '2.0', id, error: { code: ACP_ERROR.INTERNAL_ERROR, message: 'Internal error' } });
    }
    write(line);
  };

  const handleInboundRequest = async (msg) => {
    const { id, method } = msg;
    log(`acp: <- ${logMethod(method)} (request id ${logId(id)})`);
    if (typeof onRequest !== 'function') {
      respond(id, { error: { code: ACP_ERROR.METHOD_NOT_FOUND, message: 'Method not found' } });
      return;
    }
    let reply;
    try {
      const result = await onRequest(method, msg.params);
      reply = { result: result === undefined ? null : result };
    } catch (err) {
      if (err && Number.isInteger(err.code)) {
        const error = { code: err.code, message: String(err.message || 'Error') };
        if (err.data !== undefined) error.data = err.data;
        reply = { error };
      } else {
        // A crash in our handler may hold anything in its message; send none of it.
        log(`acp: handler for ${logMethod(method)} (id ${logId(id)}) threw without a JSON-RPC code`);
        reply = { error: { code: ACP_ERROR.INTERNAL_ERROR, message: 'Internal error' } };
      }
    }
    respond(id, reply);
  };

  const handleMessage = (msg) => {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      log('acp: skipped a line that is not a JSON-RPC 2.0 object');
      return;
    }
    if (typeof msg.method === 'string') {
      if (!hasOwn(msg, 'id')) {
        try {
          const ret = onNotification(msg.method, msg.params);
          if (ret && typeof ret.catch === 'function') ret.catch(() => log(`acp: notification handler for ${logMethod(msg.method)} failed`));
        } catch {
          log(`acp: notification handler for ${logMethod(msg.method)} failed`);
        }
        return;
      }
      if (!isRequestId(msg.id)) { log(`acp: skipped ${logMethod(msg.method)} with an invalid id`); return; }
      handleInboundRequest(msg);
      return;
    }
    if (hasOwn(msg, 'id') && (hasOwn(msg, 'result') || hasOwn(msg, 'error'))) {
      const entry = pending.get(msg.id);
      if (!entry) { log('acp: skipped a response to an id with no pending request'); return; }
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (hasOwn(msg, 'result') && hasOwn(msg, 'error')) {
        log(`acp: <- invalid response (both result and error) for ${entry.method} (id ${msg.id})`);
        entry.reject(localError('ACP_INVALID_RESPONSE', `ACP response to ${entry.method} (id ${msg.id}) carries both result and error`));
        return;
      }
      if (hasOwn(msg, 'error')) {
        const e = msg.error;
        // ACP requires an object with an integer code. Anything else still
        // settles the request, as an invalid response.
        if (!e || typeof e !== 'object' || Array.isArray(e) || !Number.isInteger(e.code)) {
          log(`acp: <- invalid error object for ${entry.method} (id ${msg.id})`);
          entry.reject(localError('ACP_INVALID_RESPONSE', `ACP response to ${entry.method} (id ${msg.id}) carries an invalid error object`));
          return;
        }
        const err = new Error(typeof e.message === 'string' ? e.message : 'ACP error');
        err.code = e.code;
        if (e.data !== undefined) err.data = e.data;
        log(`acp: <- error ${e.code} for ${entry.method} (id ${msg.id})`);
        entry.reject(err);
      } else {
        log(`acp: <- result for ${entry.method} (id ${msg.id})`);
        entry.resolve(msg.result);
      }
      return;
    }
    log('acp: skipped a JSON-RPC message that is neither a request, notification nor response');
  };

  const handleLine = (buf) => {
    const text = buf.toString('utf8').replace(/\r$/, '');
    if (!text.trim()) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // No preview: a stdout line can start with a key or a Bearer token.
      log(`acp: skipped a stdout line that is not JSON (${buf.length} bytes)`);
      return;
    }
    handleMessage(msg);
  };

  // Framing works on bytes: "\n" (0x0a) never occurs inside a multi-byte UTF-8
  // character, so a chunk boundary anywhere is safe.
  let parts = [];
  let partLength = 0;
  const onData = (chunk) => {
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    while (closedReason === null) {
      const nl = data.indexOf(NEWLINE);
      if (nl < 0) {
        partLength += data.length;
        if (partLength > maxMessageBytes) { overflow(); return; }
        if (data.length) parts.push(data);
        return;
      }
      const head = data.subarray(0, nl);
      if (partLength + head.length > maxMessageBytes) { overflow(); return; }
      const line = parts.length ? Buffer.concat([...parts, head]) : head;
      parts = [];
      partLength = 0;
      data = data.subarray(nl + 1);
      handleLine(line);
    }
  };
  const overflow = () => {
    parts = [];
    partLength = 0;
    close(`agent sent a message over ${maxMessageBytes} bytes`);
  };
  const onEnd = () => close('agent stdout ended');
  const onStdoutError = (err) => close(`agent stdout error: ${err.code || err.name}`);
  const onStdinError = (err) => close(`agent stdin error: ${err.code || err.name}`);

  stdout.on('data', onData);
  stdout.on('end', onEnd);
  stdout.on('close', onEnd);
  stdout.on('error', onStdoutError);
  stdin.on?.('error', onStdinError);

  return {
    request,
    notify,
    close,
    closed,
    isClosed: () => closedReason !== null,
  };
}
