/**
 * A minimal MCP stdio client for the pi bridge (pi-commonly-mcp.mjs).
 *
 * The stdio transport is newline-delimited JSON-RPC; a client for four
 * methods (initialize, tools/list, tools/call, the initialized notification)
 * is smaller than a dependency, and keeping it in a file with no pi imports
 * means the CLI's own jest can test it — `typebox` only resolves inside pi's
 * extension loader, so the extension file stays thin and untested by jest.
 */

import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_TEXT = 50 * 1024;

const truncate = (text) => (text.length <= MAX_TEXT
  ? text
  : `${text.slice(0, MAX_TEXT)}\n… [truncated ${text.length - MAX_TEXT} bytes]`);

/** A minimal MCP stdio client: initialize, tools/list, tools/call. */
export const connectMcp = ({ name, command, env }, { spawnImpl = spawn, timeoutMs = 60_000 } = {}) => {
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

/** MCP `{ content, isError }` → pi tool result. Non-text parts are named, not dropped silently. */
export const toPiResult = (result) => {
  const parts = (result?.content || []).map((c) => (c?.type === 'text' ? String(c.text ?? '') : `[${c?.type || 'content'} omitted]`));
  const text = truncate(parts.join('\n'));
  return { content: [{ type: 'text', text: result?.isError ? `error: ${text}` : text }], details: { isError: !!result?.isError } };
};

/**
 * Read the server list and REMOVE it from the environment. The list carries each
 * server's substituted env — the seat's bearer token among it — and pi's `bash`
 * tool spawns with `{ ...process.env }` (pi's getShellEnv), so leaving it in place
 * lets one `env` from the model print the token. The MCP children already hold
 * their own env from spawn time; nothing else reads this variable.
 */
export const takeServers = (env = process.env) => {
  const servers = readServers(env.COMMONLY_PI_MCP);
  delete env.COMMONLY_PI_MCP;
  return servers;
};

export const readServers = (raw) => {
  if (!raw) return [];
  try { return JSON.parse(raw).filter((s) => s?.name && Array.isArray(s.command) && s.command.length); } catch { return []; }
};

