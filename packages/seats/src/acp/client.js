/**
 * Newline-delimited JSON-RPC 2.0 over a child's stdio, as ACP's stdio
 * transport defines it: one message per line, no embedded newlines.
 *
 * The client owns framing and id bookkeeping only. What a notification or an
 * agent→client request MEANS is the adapter's business, so both arrive through
 * handlers. A request with no handler answer is -32601, which is how this
 * client declines fs/* and terminal/*: it advertised neither in initialize, so
 * an agent that asks anyway gets the standard "method not found".
 */
import { StringDecoder } from 'node:string_decoder';
import { runFailure } from '../failures.js';

/** ACP lines carry tool output and diffs, so the cap is generous, not tight. */
export const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/** A JSON-RPC error response, kept whole so the adapter can classify it. */
export class AcpRpcError extends Error {
  constructor(method, error) {
    super(`${method} failed (${error?.code}): ${error?.message || 'no message'}`);
    this.name = 'AcpRpcError';
    this.method = method;
    this.code = error?.code;
    this.rpcMessage = typeof error?.message === 'string' ? error.message : '';
    this.data = error?.data;
  }
}

/** Throw this from an onRequest handler to answer with a specific error. */
export const rpcError = (code, message) => Object.assign(new Error(message), { rpcCode: code });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasId = (message) => Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;

/**
 * @param {object} opts
 * @param {import('node:stream').Readable} opts.input   the child's stdout
 * @param {import('node:stream').Writable} opts.output  the child's stdin
 * @param {(method: string, params: any) => void} [opts.onNotification]
 * @param {(method: string, params: any) => Promise<any> | any} [opts.onRequest]
 *   resolve with the result; throw `rpcError(code, message)` to answer an error;
 *   resolve `undefined` for "not mine" and the client answers -32601.
 * @param {(failure: import('../failures.js').RunFailure) => void} [opts.onProtocolError]
 * @param {number} [opts.maxLineChars]
 */
export const createAcpClient = ({
  input, output, onNotification = () => {}, onRequest = () => undefined,
  onProtocolError = () => {}, maxLineChars = DEFAULT_MAX_LINE_CHARS,
}) => {
  const pending = new Map();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let nextId = 1;
  let broken = null;

  const write = (message) => {
    if (broken || output.destroyed || output.writableEnded) return false;
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    return true;
  };

  // Every in-flight request learns why the connection ended, so no caller
  // waits on a response that cannot come.
  const fail = (failure) => {
    if (broken) return;
    broken = failure;
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };

  const protocolError = (detail) => {
    const failure = runFailure('protocol', detail);
    fail(failure);
    onProtocolError(failure);
  };

  const answerRequest = async (message) => {
    const { id, method, params } = message;
    try {
      const result = await onRequest(method, params);
      if (result === undefined) {
        write({ id, error: { code: METHOD_NOT_FOUND, message: `method not supported by this client: ${method}` } });
      } else {
        write({ id, result });
      }
    } catch (error) {
      write({ id, error: { code: error?.rpcCode ?? INTERNAL_ERROR, message: error?.message || 'client error' } });
    }
  };

  const consume = (line) => {
    let message;
    try { message = JSON.parse(line); } catch {
      protocolError(`agent wrote a line that is not JSON (${line.length} chars)`);
      return;
    }
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      protocolError('agent wrote a message that is not JSON-RPC 2.0');
      return;
    }
    if (typeof message.method === 'string') {
      if (hasId(message)) answerRequest(message);
      // Unknown notifications are ignored by contract: ACP adds update kinds
      // faster than any client learns them.
      else onNotification(message.method, message.params);
      return;
    }
    if (!hasId(message) || !pending.has(message.id)) {
      protocolError(`agent answered a request id it was never sent: ${JSON.stringify(message.id ?? null)}`);
      return;
    }
    const { resolve, reject, method } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new AcpRpcError(method, message.error));
    else resolve(message.result);
  };

  input.on('data', (chunk) => {
    if (broken) return;
    buffer += decoder.write(chunk);
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      if (newline > maxLineChars) {
        protocolError(`agent line exceeded ${maxLineChars} chars`);
        return;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) consume(line);
      if (broken) return;
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > maxLineChars) protocolError(`agent line exceeded ${maxLineChars} chars`);
  });

  return {
    request(method, params) {
      if (broken) return Promise.reject(broken);
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        write({ id, method, params });
      });
    },
    notify(method, params) { return write({ method, params }); },
    /** End the connection; pending requests reject with `failure`. */
    close(failure) { fail(failure); },
    get broken() { return broken; },
  };
};
