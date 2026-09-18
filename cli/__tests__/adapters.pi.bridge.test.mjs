/**
 * The pi ↔ MCP bridge's stdio client against a fake MCP server: initialize,
 * tools/list, tools/call over newline-delimited JSON-RPC, and the result
 * mapping pi receives.
 */
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { connectMcp, toPiResult, readServers, takeServers } from '../src/lib/adapters/pi-mcp-client.mjs';

// A fake MCP Streamable HTTP server: records every request it receives, answers
// `initialize` with JSON and a session id, `tools/list` as an SSE event stream,
// and `tools/call` with JSON — so one test covers both response shapes the spec
// allows and the session-id echo on the second and third requests.
const startFakeHttp = async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.url.includes('status=500')) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('broker is down');
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      const msg = body ? JSON.parse(body) : null;
      if (!msg || msg.id === undefined) { res.writeHead(202); res.end(); return; }
      const json = (payload) => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }); res.end(JSON.stringify(payload)); };
      if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http' } } });
      const sse = (payload) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`); };
      if (msg.method === 'tools/list') return sse({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'commonly_echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
      if (msg.method === 'tools/call') {
        if (msg.params.name !== 'commonly_echo') return json({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown tool ' + msg.params.name } });
        return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'http:' + msg.params.arguments.text }] } });
      }
      return json({ jsonrpc: '2.0', id: msg.id, error: { message: 'unknown ' + msg.method } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () => new Promise((resolve) => {
      // Keep-alive sockets would otherwise hold `close` open forever.
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
};

// A fake MCP server: one tool, echoes its arguments; errors on `boom`.
const FAKE_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => { const m = JSON.parse(line); if (m.id === undefined) return;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake' } });
  if (m.method === 'tools/list') return reply({ tools: [{ name: 'commonly_echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  if (m.method === 'tools/call') { if (m.params.name !== 'commonly_echo') return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { message: 'unknown tool ' + m.params.name } }) + '\\n'); if (m.params.arguments.text === 'boom') return reply({ isError: true, content: [{ type: 'text', text: 'nope' }] }); return reply({ content: [{ type: 'text', text: 'echo:' + m.params.arguments.text + ':' + process.env.SEAT_ENV }] }); }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { message: 'unknown ' + m.method } }) + '\\n'); });
`;

test('initialize → tools/list → tools/call round-trip over stdio, with the server env applied', async () => {
  const client = connectMcp({ name: 'fake', command: ['node', '-e', FAKE_SERVER], env: { SEAT_ENV: 'kai' } }, { spawnImpl: spawn, timeoutMs: 5000 });
  try {
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe('fake');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['commonly_echo']);
    expect(toPiResult(await client.callTool('commonly_echo', { text: 'hi' }))).toEqual({ content: [{ type: 'text', text: 'echo:hi:kai' }], details: { isError: false } });
    expect(toPiResult(await client.callTool('commonly_echo', { text: 'boom' }))).toEqual({ content: [{ type: 'text', text: 'error: nope' }], details: { isError: true } });
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);
  } finally { client.close(); }
});

test('a request outstanding when the server dies rejects instead of hanging', async () => {
  const client = connectMcp({ name: 'dead', command: ['node', '-e', 'process.stdin.on("data", () => process.exit(3))'] }, { spawnImpl: spawn, timeoutMs: 5000 });
  await expect(client.initialize()).rejects.toThrow(/exited \(3\)/);
});

test('readServers keeps stdio AND http entries and tolerates bad JSON', () => {
  expect(readServers('[{"name":"a","command":["x"]},{"name":"b"},{"command":["y"]},{"name":"c","url":"https://api.example/mcp"}]'))
    .toEqual([{ name: 'a', command: ['x'] }, { name: 'c', url: 'https://api.example/mcp' }]);
  expect(readServers('[{"name":"d","url":""},{"name":"e","command":[]}]')).toEqual([]);
  expect(readServers('not json')).toEqual([]);
  expect(readServers(undefined)).toEqual([]);
});

// The wire is built by resolveMcpServers, which now emits exactly one of
// command/url per entry. An entry carrying both did not come from it — and the
// bridge is the layer that spawns, so an unclassifiable shape is dropped rather
// than run as the command half of it (Vera, Connectors 69774).
test('readServers drops an entry that carries both a command and a url', () => {
  const both = '[{"name":"broker","command":["sh","-c","curl https://evil.example"],"url":"https://api.example/mcp"}]';
  expect(readServers(both)).toEqual([]);
});

test("takeServers reads the server list and removes it from the env, so pi's bash tool cannot print the seat token", () => {
  const list = [{ name: 'commonly', command: ['node', 'srv.js'], env: { COMMONLY_AGENT_TOKEN: 'cm_agent_secret' } }];
  const env = { COMMONLY_PI_MCP: JSON.stringify(list), OTHER: 'kept' };
  expect(takeServers(env)).toEqual(list);
  expect('COMMONLY_PI_MCP' in env).toBe(false);
  expect(env.OTHER).toBe('kept');
  expect(JSON.stringify(env)).not.toContain('cm_agent_secret');
});

test('initialize → tools/list → tools/call over Streamable HTTP, with the declared bearer header and the negotiated session', async () => {
  const fake = await startFakeHttp();
  const client = connectMcp({
    name: 'broker',
    url: fake.url,
    headers: { Authorization: 'Bearer cm_agent_secret' },
  }, { timeoutMs: 5000 });
  try {
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe('fake-http');
    expect((await client.listTools()).map((t) => t.name)).toEqual(['commonly_echo']);
    expect(toPiResult(await client.callTool('commonly_echo', { text: 'hi' })))
      .toEqual({ content: [{ type: 'text', text: 'http:hi' }], details: { isError: false } });
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool nope/);

    const posts = fake.seen.filter((r) => r.method === 'POST');
    // initialize, notifications/initialized, tools/list, tools/call, tools/call
    expect(posts).toHaveLength(5);
    // Every request carries the declared header — this is the grant broker's
    // Authorization, the whole reason a pi seat can reach the broker at all.
    for (const req of posts) expect(req.headers.authorization).toBe('Bearer cm_agent_secret');
    // Both response shapes are accepted, so the request advertises both.
    expect(posts[0].headers.accept).toContain('text/event-stream');
    // The session the server handed back rides on everything after initialize.
    expect(posts[0].headers['mcp-session-id']).toBeUndefined();
    expect(posts[2].headers['mcp-session-id']).toBe('sess-1');
    expect(posts[2].headers['mcp-protocol-version']).toBe('2025-06-18');
    // A notification has no id.
    expect(posts[1].body.id).toBeUndefined();
    expect(posts[0].body.params.clientInfo.name).toBe('commonly-pi-bridge');
  } finally {
    client.close();
    await fake.close();
  }
});

test('an HTTP failure is surfaced with its status, not swallowed as an empty tool list', async () => {
  const fake = await startFakeHttp();
  const client = connectMcp({ name: 'broken', url: `${fake.url}?status=500`, headers: {} }, { timeoutMs: 5000 });
  try {
    // The status AND the server's body, so this cannot pass off the fallback
    // "returned no JSON-RPC answer" path — that would hide a dropped status check.
    await expect(client.initialize()).rejects.toThrow(/^broken: initialize failed with HTTP 500: broker is down$/);
  } finally {
    await fake.close();
  }
});

test('a server that never answers times out instead of hanging the seat', async () => {
  const fake = await startFakeHttp();
  const client = connectMcp({ name: 'slow', url: fake.url }, {
    timeoutMs: 50,
    fetchImpl: () => new Promise(() => {}),
  });
  try {
    await expect(client.initialize()).rejects.toThrow(/slow: timed out after 50ms|no fetch/);
  } finally {
    await fake.close();
  }
});

// Presence guard, not a behaviour test: the bridge imports `typebox`, which resolves only
// inside pi's extension loader, so jest cannot load it. This pins that it takes (and so
// deletes) the list rather than only reading it.
test('the bridge takes the server list rather than reading it in place', () => {
  const bridge = readFileSync(new URL('../src/lib/adapters/pi-commonly-mcp.mjs', import.meta.url), 'utf8');
  expect(bridge).toContain('takeServers(process.env)');
  expect(bridge).not.toMatch(/readServers\(process\.env/);
});
