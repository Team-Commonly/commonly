/**
 * The MCP bridge for the microVM sandbox (microsandbox.js).
 *
 * A seat's stdio MCP servers (the Commonly MCP above all) run on the HOST, not
 * in the guest. They hold the agent's runtime token and call the Commonly API,
 * and the guest's fence allows neither: its only way out is the provider proxy
 * and this bridge. So the credential never enters the VM, and the guest needs no
 * API egress.
 *
 * Inside the guest, Claude's MCP config names a shim per server. The shim
 * connects to the bridge on host.microsandbox.internal:<port>, sends one line
 * (`<secret> <server name>`), then pipes stdio. The bridge checks the per-turn
 * secret, spawns that server exactly as Claude would have on the host, and pipes
 * the socket to its stdio. The bridge listens on 127.0.0.1 only, and the secret
 * is what keeps another local process from taking a session with the seat's
 * token: anything that cannot read the turn folder cannot connect.
 */
import { spawn } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import net from 'net';

export const MCP_BRIDGE_ENV = 'COMMONLY_MCP_BRIDGE';
export const MCP_BRIDGE_SECRET_ENV = 'COMMONLY_MCP_BRIDGE_SECRET';

// Runs inside the guest as each MCP server's command.
export const MCP_SHIM_SOURCE = `'use strict';
const net = require('net');
const [host, port] = String(process.env.${MCP_BRIDGE_ENV} || '').split(':');
const socket = net.connect(Number(port), host, () => {
  socket.write(String(process.env.${MCP_BRIDGE_SECRET_ENV} || '') + ' ' + process.argv[2] + '\\n');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', (error) => { process.stderr.write('commonly-mcp-shim: ' + error.message + '\\n'); process.exit(1); });
socket.on('close', () => process.exit(0));
`;

// Claude expands \${VAR} and \${VAR:-default} in an MCP entry's command, args and
// env. The bridge starts the servers instead of Claude, so it expands them the
// same way, from the values Claude would have held.
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
export const expandPlaceholders = (value, vars = {}) => String(value).replace(
  PLACEHOLDER,
  (_, name, fallback) => (vars[name] !== undefined && vars[name] !== '' ? String(vars[name]) : (fallback ?? '')),
);

/**
 * The host-side spawn spec for each server in a Claude MCP config. Only stdio
 * servers cross the bridge. An HTTP or SSE server would be reached by Claude
 * itself, from inside the fence, so it is refused rather than silently cut off.
 */
export const hostMcpServers = (config, vars = {}) => {
  const servers = new Map();
  for (const [name, entry] of Object.entries(config?.mcpServers || {})) {
    const type = entry?.type || (entry?.url ? 'http' : 'stdio');
    if (type !== 'stdio' || !entry?.command) {
      throw new Error(`The microVM sandbox runs stdio MCP servers only, and ${name} is ${type}.`);
    }
    if (/[\s\n]/.test(name)) throw new Error(`MCP server name ${JSON.stringify(name)} cannot cross the microVM bridge`);
    servers.set(name, {
      command: expandPlaceholders(entry.command, vars),
      args: (entry.args || []).map((arg) => expandPlaceholders(arg, vars)),
      env: Object.fromEntries(Object.entries(entry.env || {})
        .map(([key, value]) => [key, expandPlaceholders(value, vars)])),
    });
  }
  return servers;
};

const sameSecret = (given, secret) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

const MAX_HANDSHAKE_BYTES = 512;
// A turn's Claude starts one session per server; these caps only stop a guest
// from starting host processes without end.
export const MAX_LIVE_SESSIONS = 8;
export const MAX_SESSIONS_PER_TURN = 64;

/**
 * Starts the bridge for one turn. Returns its port, the secret the guest must
 * send, and close(), which stops every server it started.
 */
export const startMcpBridge = async ({
  servers,
  baseEnv = {},
  host = '127.0.0.1',
  cwd,
  spawnImpl = spawn,
  handshakeTimeoutMs = 10000,
} = {}) => {
  const secret = randomBytes(24).toString('hex');
  const children = new Set();
  const sockets = new Set();
  let started = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline === -1) {
        if (pending.length > MAX_HANDSHAKE_BYTES) socket.destroy();
        return;
      }
      socket.off('data', onData);
      clearTimeout(timer);
      const line = pending.subarray(0, newline).toString('utf8');
      const rest = pending.subarray(newline + 1);
      const space = line.indexOf(' ');
      const name = space === -1 ? '' : line.slice(space + 1);
      if (space === -1 || !sameSecret(line.slice(0, space), secret) || !servers.has(name)) {
        socket.destroy();
        return;
      }
      if (children.size >= MAX_LIVE_SESSIONS || started >= MAX_SESSIONS_PER_TURN) {
        socket.destroy();
        return;
      }
      started += 1;
      const spec = servers.get(name);
      let child;
      try {
        child = spawnImpl(spec.command, spec.args, {
          env: { ...baseEnv, ...spec.env },
          ...(cwd ? { cwd } : {}),
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch {
        socket.destroy();
        return;
      }
      children.add(child);
      child.on('error', () => socket.destroy());
      child.on('exit', () => { children.delete(child); socket.end(); });
      child.stdin.on('error', () => {});
      if (rest.length) child.stdin.write(rest);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      socket.on('close', () => { if (children.has(child)) child.kill(); });
    };
    socket.on('data', onData);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  return {
    port,
    secret,
    // Stops every server it started and waits for them to exit (up to 3 s), so
    // nothing of the turn outlives it, or holds its folder open on Windows.
    close: async () => {
      const exits = [...children].map((child) => new Promise((resolve) => {
        if (child.exitCode !== null && child.exitCode !== undefined) { resolve(); return; }
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      }));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...exits, new Promise((resolve) => { server.close(() => resolve()); })]);
    },
  };
};

export default {
  MCP_BRIDGE_ENV, MCP_BRIDGE_SECRET_ENV, MCP_SHIM_SOURCE, expandPlaceholders, hostMcpServers, startMcpBridge,
};
