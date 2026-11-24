/**
 * sandbox.microsandbox-mcp-bridge.test.mjs: the host side of a microVM seat's
 * MCP servers. The bridge is the only way MCP crosses the VM boundary, so a
 * connection without the turn's secret must get nothing at all.
 */
import { jest } from '@jest/globals';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

import {
  MAX_LIVE_SESSIONS, MCP_BRIDGE_ENV, MCP_BRIDGE_SECRET_ENV, MCP_SHIM_SOURCE, expandPlaceholders, hostMcpServers,
  startMcpBridge,
} from '../src/lib/sandbox/microsandbox-mcp-bridge.js';

// A stand-in stdio server: echoes each line back with its env marker.
const ECHO_SERVER = "process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',(c)=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);process.stdout.write('echo['+(process.env.MARK||'')+']:'+l+'\\n');}});";
const echoServers = () => new Map([['commonly', { command: process.execPath, args: ['-e', ECHO_SERVER], env: { MARK: 'host-side' } }]]);

const talk = (port, firstLine, payload, { waitMs = 1500 } = {}) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  let out = '';
  socket.on('connect', () => { socket.write(`${firstLine}\n${payload}`); });
  socket.on('data', (chunk) => { out += chunk; });
  const done = () => { socket.destroy(); resolve(out); };
  socket.on('close', () => resolve(out));
  socket.on('error', () => resolve(out));
  setTimeout(done, waitMs);
});

describe('expandPlaceholders', () => {
  test('expands ${VAR} and ${VAR:-default} the way Claude does', () => {
    expect(expandPlaceholders('${A}/${B:-fallback}/${C}', { A: 'one' })).toBe('one/fallback/');
    expect(expandPlaceholders('plain', {})).toBe('plain');
  });
});

describe('hostMcpServers', () => {
  test('builds host spawn specs from a Claude MCP config', () => {
    const servers = hostMcpServers({
      mcpServers: {
        commonly: { command: 'node', args: ['${SERVER}'], env: { COMMONLY_AGENT_TOKEN_FILE: '${TOKEN_FILE}' } },
      },
    }, { SERVER: 'mcp.js', TOKEN_FILE: 'C:\\t\\token' });
    expect(servers.get('commonly')).toEqual({
      command: 'node', args: ['mcp.js'], env: { COMMONLY_AGENT_TOKEN_FILE: 'C:\\t\\token' },
    });
  });
  test.each([
    [{ type: 'http', url: 'https://x' }],
    [{ url: 'https://x' }],
    [{ type: 'sse', url: 'https://x' }],
    [{ type: 'stdio' }],
  ])('refuses a server the bridge cannot carry: %p', (entry) => {
    expect(() => hostMcpServers({ mcpServers: { remote: entry } })).toThrow(/stdio MCP servers only/);
  });
});

describe('startMcpBridge', () => {
  let bridge;
  afterEach(async () => { await bridge?.close(); bridge = null; });

  test('listens on loopback only', async () => {
    bridge = await startMcpBridge({ servers: echoServers() });
    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.secret).toMatch(/^[0-9a-f]{48}$/);
  });

  test('with the secret, the named server runs on the host and its stdio crosses', async () => {
    bridge = await startMcpBridge({ servers: echoServers() });
    const out = await talk(bridge.port, `${bridge.secret} commonly`, 'ping\n');
    expect(out).toBe('echo[host-side]:ping\n');
  });

  test('a wrong secret gets nothing, and no server starts', async () => {
    const spawnImpl = jest.fn(spawn);
    bridge = await startMcpBridge({ servers: echoServers(), spawnImpl });
    expect(await talk(bridge.port, `${'0'.repeat(48)} commonly`, 'ping\n')).toBe('');
    expect(await talk(bridge.port, 'commonly', 'ping\n')).toBe('');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('starts each server in the workspace folder it was given', async () => {
    const spawnImpl = jest.fn(spawn);
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-cwd-'));
    try {
      bridge = await startMcpBridge({ servers: echoServers(), spawnImpl, cwd });
      expect(await talk(bridge.port, `${bridge.secret} commonly`, 'ping\n')).toBe('echo[host-side]:ping\n');
      expect(spawnImpl.mock.calls[0][2].cwd).toBe(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('caps the live sessions a guest can start', async () => {
    // A stand-in that never exits, so every session stays live.
    const spawnImpl = jest.fn(() => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      return child;
    });
    bridge = await startMcpBridge({ servers: echoServers(), spawnImpl });
    const sockets = [];
    for (let i = 0; i < MAX_LIVE_SESSIONS + 2; i += 1) {
      const socket = net.connect(bridge.port, '127.0.0.1');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => socket.on('connect', resolve));
      socket.on('error', () => {});
      socket.write(`${bridge.secret} commonly\n`);
      sockets.push(socket);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    expect(spawnImpl).toHaveBeenCalledTimes(MAX_LIVE_SESSIONS);
    for (const socket of sockets) socket.destroy();
  });

  test('an unknown server name gets nothing', async () => {
    const spawnImpl = jest.fn(spawn);
    bridge = await startMcpBridge({ servers: echoServers(), spawnImpl });
    expect(await talk(bridge.port, `${bridge.secret} other`, 'ping\n')).toBe('');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  test('a handshake that never ends is dropped', async () => {
    bridge = await startMcpBridge({ servers: echoServers(), handshakeTimeoutMs: 200 });
    const closed = await new Promise((resolve) => {
      const socket = net.connect(bridge.port, '127.0.0.1', () => socket.write('no newline'));
      socket.on('close', () => resolve(true));
      socket.on('error', () => resolve(true));
      setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    });
    expect(closed).toBe(true);
  });

  test('close() stops the servers it started', async () => {
    bridge = await startMcpBridge({ servers: echoServers() });
    const socket = net.connect(bridge.port, '127.0.0.1');
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write(`${bridge.secret} commonly\nping\n`);
    await new Promise((resolve) => socket.once('data', resolve));
    const closed = new Promise((resolve) => socket.on('close', resolve));
    await bridge.close();
    bridge = null;
    await closed;
  });
});

describe('the guest shim', () => {
  let dir;
  let bridge;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-shim-')); });
  afterEach(async () => { await bridge?.close(); rmSync(dir, { recursive: true, force: true }); });

  test('carries stdio to the bridge with the secret from its env', async () => {
    bridge = await startMcpBridge({ servers: echoServers() });
    const shim = join(dir, 'mcp-shim.js');
    writeFileSync(shim, MCP_SHIM_SOURCE);
    const child = spawn(process.execPath, [shim, 'commonly'], {
      env: { [MCP_BRIDGE_ENV]: `127.0.0.1:${bridge.port}`, [MCP_BRIDGE_SECRET_ENV]: bridge.secret },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stdin.write('hello\n');
    await new Promise((resolve) => {
      const check = setInterval(() => { if (out.includes('\n')) { clearInterval(check); resolve(); } }, 20);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
    child.kill();
    expect(out).toBe('echo[host-side]:hello\n');
  });
});
