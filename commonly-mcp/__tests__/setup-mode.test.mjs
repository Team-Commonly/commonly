/**
 * Setup mode: a plugin install that has no token yet.
 *
 * A plugin host (the Codex plugin, for one) points COMMONLY_TOKEN_FILE at a
 * file the person writes after installing. Before setup mode, a missing file
 * ended the server at start, and Codex showed only that the Commonly tools
 * were missing: the path in the startup error never reached the person
 * (walked 2026-11-13, Codex 0.162.1). With COMMONLY_MCP_SETUP_MODE=1, the
 * server starts anyway and tells the model, and through it the person, where
 * the token goes and how to get one.
 *
 * It is opt-in because the CLI's own seats pass their token through the same
 * file variable, and a seat whose file is missing must still fail loudly.
 */
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  SETUP_MODE_ENV, missingTokenFile, setupMessage, createSetupServer,
} from '../src/setup-mode.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let dir;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'commonly-setup-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('missingTokenFile', () => {
  test('names the declared file when setup mode is on and the file is absent', () => {
    const file = path.join(dir, 'token');
    expect(missingTokenFile({ [SETUP_MODE_ENV]: '1', COMMONLY_TOKEN_FILE: file })).toBe(file);
  });

  test('names the declared file when it is empty or only whitespace', () => {
    const file = path.join(dir, 'token');
    writeFileSync(file, ' \n');
    expect(missingTokenFile({ [SETUP_MODE_ENV]: '1', COMMONLY_TOKEN_FILE: file })).toBe(file);
  });

  test('is null with setup mode off, so a seat whose file is missing still fails at start', () => {
    expect(missingTokenFile({ COMMONLY_TOKEN_FILE: path.join(dir, 'token') })).toBeNull();
    expect(missingTokenFile({ [SETUP_MODE_ENV]: '0', COMMONLY_TOKEN_FILE: path.join(dir, 'token') })).toBeNull();
  });

  test('is null when the file holds a token, or when a pipe is declared', () => {
    const file = path.join(dir, 'token');
    writeFileSync(file, 'cm_agent_present\n');
    expect(missingTokenFile({ [SETUP_MODE_ENV]: '1', COMMONLY_TOKEN_FILE: file })).toBeNull();
    expect(missingTokenFile({ [SETUP_MODE_ENV]: '1', COMMONLY_TOKEN_FD: '3', COMMONLY_TOKEN_FILE: path.join(dir, 'none') })).toBeNull();
  });

  test('is null when the file exists but cannot be read, so that error stays loud', () => {
    if (process.getuid && process.getuid() === 0) return; // root reads a 000 file
    const file = path.join(dir, 'token');
    writeFileSync(file, 'cm_agent_present\n');
    chmodSync(file, 0o000);
    expect(missingTokenFile({ [SETUP_MODE_ENV]: '1', COMMONLY_TOKEN_FILE: file })).toBeNull();
  });
});

describe('setupMessage', () => {
  test('names the path, the hosted page and the steps', () => {
    const text = setupMessage({ tokenPath: '/data/plugin/token', apiUrl: 'https://api.commonly.me' });
    expect(text).toContain('Commonly is not connected yet');
    expect(text).toContain('/data/plugin/token');
    expect(text).toContain('https://commonly.me/v2/agents/byo');
    expect(text).toContain('chmod 600 /data/plugin/token');
    expect(text).toMatch(/new session/);
    // Walked: without this line Codex told the user "the plugin's configured token file" instead of the path.
    expect(text).toContain('with the full path exactly as written');
  });

  test('a self-hosted instance gets the page path, not commonly.me', () => {
    const text = setupMessage({ tokenPath: '/t', apiUrl: 'https://chat.example.org' });
    expect(text).not.toContain('commonly.me');
    expect(text).toContain('/v2/agents/byo');
  });
});

describe('the setup server', () => {
  const connect = async () => {
    const server = createSetupServer({ tokenPath: '/data/plugin/token', apiUrl: 'https://api.commonly.me' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '0.0.0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    return client;
  };

  test('lists one read-only tool, commonly_get_started, that says it is not connected', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['commonly_get_started']);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(tools[0].description).toMatch(/not connected yet/);
    await client.close();
  });

  test('carries the steps as server instructions', async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain('/data/plugin/token');
    await client.close();
  });

  test('commonly_get_started returns the steps; any other tool name gets them as an error', async () => {
    const client = await connect();
    const ok = await client.callTool({ name: 'commonly_get_started', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('/data/plugin/token');
    const other = await client.callTool({ name: 'commonly_post_message', arguments: { podId: 'x', content: 'hi' } });
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toContain('/data/plugin/token');
    await client.close();
  });
});

describe('the entry point', () => {
  const start = (env) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: { PATH: process.env.PATH, COMMONLY_API_URL: 'http://127.0.0.1:9', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = { stdout: '', stderr: '', code: null };
    child.stdout.on('data', (d) => { out.stdout += d; });
    child.stderr.on('data', (d) => { out.stderr += d; });
    child.on('exit', (code) => { out.code = code; });
    return { child, out };
  };
  const waitFor = async (check, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (check()) return true;
      await new Promise((r) => { setTimeout(r, 25); });
    }
    return false;
  };
  const rpc = (child, id, method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);

  test('with setup mode on and no token file, it starts, answers, and says where the token goes', async () => {
    const file = path.join(dir, 'token');
    const { child, out } = start({ [SETUP_MODE_ENV]: '1', COMMONLY_TOKEN_FILE: file });
    rpc(child, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    rpc(child, 2, 'tools/call', { name: 'commonly_get_started', arguments: {} });
    expect(await waitFor(() => out.stdout.includes('"id":2'))).toBe(true);
    const reply = out.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
    expect(reply.result.content[0].text).toContain(file);
    expect(out.stderr).toContain(file);
    expect(out.code).toBeNull();
    child.kill();
  });

  test('with setup mode off, a missing token file still ends the server at start', async () => {
    const { out } = start({ COMMONLY_TOKEN_FILE: path.join(dir, 'token') });
    expect(await waitFor(() => out.code !== null)).toBe(true);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('fatal: COMMONLY_TOKEN_FILE=');
  });
});
