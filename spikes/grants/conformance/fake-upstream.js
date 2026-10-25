#!/usr/bin/env node
/**
 * A tiny upstream MCP server (Streamable HTTP, JSON responses) for the broker
 * to forward to. It insists on the broker's credential, and remembers which
 * Authorization values it saw so the suite can prove the caller's grant token
 * never travels upstream.
 *
 * Env: FAKE_UPSTREAM_CREDENTIAL (required), FAKE_UPSTREAM_PORT (default 0).
 * GET /_seen returns the counters; POST /_reset clears them.
 */
import { createServer } from 'node:http';

const credential = process.env.FAKE_UPSTREAM_CREDENTIAL;
if (!credential) { process.stderr.write('FAKE_UPSTREAM_CREDENTIAL is required\n'); process.exit(2); }

const TOOLS = [
  { name: 'read_issue', description: 'Read one issue', inputSchema: { type: 'object', properties: { number: { type: 'integer' }, echoAuth: { type: 'boolean' } } } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { state: { type: 'string' } } } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'delete_repo', description: 'Delete the repository', inputSchema: { type: 'object', properties: {} } },
];

let seen = { credentialOk: 0, otherAuth: [], calls: {} };

const reply = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
};

const handleRpc = (msg, auth) => {
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-upstream', version: '0' } });
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } };
      seen.calls[name] = (seen.calls[name] || 0) + 1;
      // echoAuth simulates a careless upstream that reflects its own credential.
      const text = JSON.stringify({ tool: name, args, ...(args.echoAuth ? { auth: auth } : {}) });
      return ok({ content: [{ type: 'text', text }] });
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
  }
};

const server = createServer((req, res) => {
  if (req.url === '/_seen') return reply(res, 200, seen);
  if (req.url === '/_reset') { seen = { credentialOk: 0, otherAuth: [], calls: {} }; return reply(res, 200, {}); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${credential}`) {
      seen.otherAuth.push(auth);
      return reply(res, 401, { error: 'bad credential' });
    }
    seen.credentialOk += 1;
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, { error: 'parse' }); }
    return reply(res, 200, handleRpc(msg, auth));
  });
});

server.listen(Number(process.env.FAKE_UPSTREAM_PORT || 0), '127.0.0.1', () => {
  const { address, port } = server.address();
  process.stdout.write(`${JSON.stringify({ listening: `${address}:${port}` })}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
