// The "front" for the sandbox spikes (docs/plans/openshell-spike.md,
// docs/plans/microsandbox-windows-spike.md): what sits between a sandbox and the world.
//   - stub model upstream on 127.0.0.1:18090 (Anthropic Messages + OpenAI Responses),
//     which ECHOES the key it received, so a run shows whether our proxy redacted it;
//   - Commonly's real provider proxy (packages/seats/src/wire/provider-proxy.js), one
//     per wire, holding FAKE upstream keys;
//   - forwarders on FRONT_BIND:18100/18101 to the loopback-only proxies, which a
//     sandbox reaches through its host alias (host.openshell.internal,
//     host.microsandbox.internal);
//   - a stub grant broker on FRONT_BIND:18102 shaped like POST /api/mcp/grants/:grantId.
// FRONT_DIR (default /run/front) gets front.json (per-spawn proxy tokens, 0600) and
// requests.log, outside every sandbox. Every key here is fake; nothing reaches a
// real provider. Spike tooling only, never run in a deployment.
import { createServer } from 'node:http';
import net from 'node:net';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { startProviderProxy } from '../../packages/seats/src/wire/provider-proxy.js';

const FAKE_ANTHROPIC_KEY = 'fake-anthropic-upstream-key-0001';
const FAKE_OPENAI_KEY = 'fake-openai-upstream-key-0002';
const FAKE_AGENT_TOKEN = 'fake-agent-token-0003';
const DIR = process.env.FRONT_DIR || '/run/front';
// Loopback by default; the OpenShell harness sets 0.0.0.0 for its Docker host.
const BIND = process.env.FRONT_BIND || '127.0.0.1';
const LOG = `${DIR}/requests.log`;
mkdirSync(DIR, { recursive: true });
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
});

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

// 1. Stub upstream.
const upstream = createServer(async (req, res) => {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* not json */ }
  const anthropicKey = req.headers['x-api-key'] || '';
  const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const path = req.url.split('?')[0];
  log(`upstream ${req.method} ${req.url} x-api-key=${anthropicKey ? (anthropicKey === FAKE_ANTHROPIC_KEY ? 'REAL(fake)' : 'OTHER') : '-'} bearer=${bearer ? (bearer === FAKE_OPENAI_KEY ? 'REAL(fake)' : 'OTHER') : '-'} model=${body.model || '-'} stream=${Boolean(body.stream)}`);

  if (req.method === 'GET' && path.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'spike-model', type: 'model', object: 'model' }] }));
    return;
  }
  if (path === '/v1/messages/count_tokens') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 12 }));
    return;
  }
  if (path === '/v1/messages') {
    const text = `OK from the stub model. key-echo=${anthropicKey}`;
    const model = body.model || 'spike-model';
    const usage = { input_tokens: 12, output_tokens: 8 };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_spike', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage,
      }));
      return;
    }
    sse(res, [
      ['message_start', { type: 'message_start', message: { id: 'msg_spike', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
    return;
  }
  if (path === '/v1/responses') {
    const text = `OK from the stub model. key-echo=${bearer}`;
    const item = { type: 'message', id: 'msg_spike', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const usage = { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 };
    const response = { id: 'resp_spike', object: 'response', model: body.model || 'spike-model', status: 'in_progress', output: [] };
    sse(res, [
      ['response.created', { type: 'response.created', response }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_spike', output_index: 0, content_index: 0, delta: text }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
      ['response.completed', { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage } }],
    ]);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'stub: no route' }));
});
await new Promise((r) => upstream.listen(18090, '127.0.0.1', r));

// 2. Commonly's provider proxies (loopback, per-spawn token, fake upstream keys).
const anthropic = await startProviderProxy({
  provider: { baseURL: 'http://127.0.0.1:18090' }, keyMaterial: FAKE_ANTHROPIC_KEY,
  wire: 'anthropic-messages', adapterLabel: 'ClaudeCode-spike',
});
const openai = await startProviderProxy({
  provider: { baseURL: 'http://127.0.0.1:18090/v1' }, keyMaterial: FAKE_OPENAI_KEY,
  wire: 'openai-responses', adapterLabel: 'Codex-spike',
});

// 3. Forwarders the sandbox reaches through its host alias.
const forward = (listenPort, targetPort, label) => net.createServer((client) => {
  log(`forward ${label} connection from ${client.remoteAddress}`);
  const upstreamSock = net.connect(targetPort, '127.0.0.1');
  client.pipe(upstreamSock).pipe(client);
  const end = () => { client.destroy(); upstreamSock.destroy(); };
  client.on('error', end); upstreamSock.on('error', end);
}).listen(listenPort, BIND);
forward(18100, anthropic.port, 'anthropic-proxy');
forward(18101, openai.port, 'openai-proxy');

// 4. Stub grant broker.
createServer(async (req, res) => {
  const raw = await readBody(req);
  const ok = req.method === 'POST' && req.url === '/api/mcp/grants/g-spike'
    && req.headers.authorization === `Bearer ${FAKE_AGENT_TOKEN}`;
  log(`broker ${req.method} ${req.url} auth=${ok ? 'ok' : 'refused'} bytes=${raw.length}`);
  res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ok
    ? { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'broker ok: grant g-spike' }] } }
    : { error: 'unauthorized' }));
}).listen(18102, BIND);

writeFileSync(`${DIR}/front.json`, JSON.stringify({
  anthropicProxyToken: anthropic.token,
  openaiProxyToken: openai.token,
  agentToken: FAKE_AGENT_TOKEN,
  fakeKeys: [FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY],
  ports: { anthropic: 18100, openai: 18101, broker: 18102, upstream: 18090 },
}), { mode: 0o600 });
log('front ready');
console.log('front ready');
