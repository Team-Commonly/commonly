/**
 * F175b: the stdio bridge that puts the grant broker (a Streamable HTTP MCP
 * server) in front of codex, which runs stdio MCP servers only. The bridge
 * reads the seat token from the per-spawn credential file on every request, so
 * the token never rides codex's argv or environment.
 */
import { jest } from '@jest/globals';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  BRIDGE_HEADERS_VAR, BRIDGE_PATH, BRIDGE_URL_VAR, CREDENTIAL_FILE_VAR as BRIDGE_FILE_VAR, createBrokerBridge,
} from '../src/lib/adapters/codex-broker-bridge.mjs';
import { CREDENTIAL_FILE_VAR } from '../src/lib/credential-file.js';

const URL = 'https://api.example.test/api/mcp/grants/g1';
const TEMPLATES = { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' };

const tokenFile = async (token = 'cm_agent_secret') => {
  const dir = await mkdtemp(join(tmpdir(), 'commonly-bridge-test-'));
  const path = join(dir, 'token');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return path;
};

const jsonResponse = (body, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => ({ 'content-type': 'application/json', ...headers })[name.toLowerCase()] ?? null },
  text: async () => (body === null ? '' : JSON.stringify(body)),
});

const bridgeWith = async (fetchImpl, overrides = {}) => {
  const out = [];
  const bridge = createBrokerBridge({
    url: URL,
    headerTemplates: TEMPLATES,
    tokenFile: await tokenFile(),
    fetchImpl,
    write: (line) => out.push(JSON.parse(line)),
    ...overrides,
  });
  return { bridge, out };
};

describe('createBrokerBridge', () => {
  test('forwards a request to the broker with the token read from the file, and writes the answer', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    const { bridge, out } = await bridgeWith(fetchImpl);

    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers.Authorization).toBe('Bearer cm_agent_secret');
    expect(init.headers.accept).toBe('application/json, text/event-stream');
    expect(JSON.parse(init.body)).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { tools: [] } }]);
  });

  test('re-reads the credential file on every request, so a rotated token is used', async () => {
    const file = await tokenFile('cm_agent_first');
    const fetchImpl = jest.fn(async (_url, init) => jsonResponse({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: {} }));
    const { bridge } = await bridgeWith(fetchImpl, { tokenFile: file });

    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    await writeFile(file, 'cm_agent_second\n');
    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));

    expect(fetchImpl.mock.calls.map(([, init]) => init.headers.Authorization))
      .toEqual(['Bearer cm_agent_first', 'Bearer cm_agent_second']);
  });

  test('echoes the negotiated protocol version on every request after initialize', async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26' } });
      if (msg.id === undefined) return jsonResponse(null, { status: 202 });
      return jsonResponse({ jsonrpc: '2.0', id: msg.id, result: {} });
    });
    const { bridge, out } = await bridgeWith(fetchImpl);

    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));

    expect(fetchImpl.mock.calls[0][1].headers['mcp-protocol-version']).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1].headers['mcp-protocol-version']).toBe('2025-03-26');
    expect(fetchImpl.mock.calls[2][1].headers['mcp-protocol-version']).toBe('2025-03-26');
    // A 202 to a notification writes nothing.
    expect(out.map((m) => m.id)).toEqual([1, 2]);
  });

  test('reads an event-stream answer', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } })}\n\n`,
    }));
    const { bridge, out } = await bridgeWith(fetchImpl);

    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } }));

    expect(out).toEqual([{ jsonrpc: '2.0', id: 7, result: { ok: true } }]);
  });

  test('an HTTP failure answers the request with a JSON-RPC error instead of leaving codex waiting', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ error: 'grant_revoked' }, { status: 403 }));
    const { bridge, out } = await bridgeWith(fetchImpl);

    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call' }));

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(3);
    expect(out[0].error.message).toMatch(/HTTP 403/);
  });

  test('a missing credential file is an error answer, and nothing is sent without a token', async () => {
    const fetchImpl = jest.fn();
    const { bridge, out } = await bridgeWith(fetchImpl, { tokenFile: join(tmpdir(), 'commonly-bridge-nope', 'token') });

    await bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out[0].id).toBe(4);
    expect(out[0].error.message).toMatch(/credential/);
  });

  test('a line that is not JSON gets a parse error and nothing is sent', async () => {
    const fetchImpl = jest.fn();
    const { bridge, out } = await bridgeWith(fetchImpl);

    await bridge.handleLine('not json');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }]);
  });
});

describe('what a public seat\'s read grant has to cover', () => {
  // The public profile grants read on the bridge file alone, so the file may
  // import nothing but node builtins.
  test('the bridge imports node builtins only', () => {
    const source = readFileSync(BRIDGE_PATH, 'utf8');
    const specifiers = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });

  test('it reads the credential path from the variable the adapters write', () => {
    expect(BRIDGE_FILE_VAR).toBe(CREDENTIAL_FILE_VAR);
  });
});

describe('the bridge as codex runs it: a stdio child', () => {
  test('carries the token only in the HTTP header; argv and env hold the path, never the value', async () => {
    const seen = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        seen.push({ url: req.url, authorization: req.headers.authorization, msg });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'github_get_issue' }] } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const file = await tokenFile('cm_agent_child_secret');

    const env = {
      PATH: process.env.PATH,
      [BRIDGE_URL_VAR]: `http://127.0.0.1:${port}/api/mcp/grants/g1`,
      [BRIDGE_HEADERS_VAR]: JSON.stringify(TEMPLATES),
      COMMONLY_TOKEN_FILE: file,
    };
    const argv = [BRIDGE_PATH];
    const child = spawn(process.execPath, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const answer = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (chunk) => {
          buf += chunk;
          const nl = buf.indexOf('\n');
          if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
        });
        child.on('error', reject);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
      });

      expect(answer).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'github_get_issue' }] } });
      expect(seen[0].url).toBe('/api/mcp/grants/g1');
      expect(seen[0].authorization).toBe('Bearer cm_agent_child_secret');
      expect(JSON.stringify(argv)).not.toContain('cm_agent_child_secret');
      expect(JSON.stringify(env)).not.toContain('cm_agent_child_secret');
    } finally {
      child.kill();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
