/**
 * A local OpenAI-compatible model server for tests and the compatibility
 * matrix. Real CLIs (goose, opencode, hermes, …) point their provider base URL
 * here and run a genuine turn with no key and no network.
 *
 * Behaviour is chosen per request by a directive in the last user message:
 *   [[reply:TEXT]]  answer TEXT (default: PONG)
 *   [[stall]]       accept the request and never answer (liveness tests)
 *   [[refuse]]      answer HTTP 400 with a content-policy error body
 *   [[fail:CODE]]   answer HTTP CODE
 * Serves POST /v1/chat/completions (stream and non-stream) and GET /v1/models.
 */
import { createServer } from 'node:http';

const directiveOf = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const text = messages.filter((m) => m?.role === 'user').map((m) => (
    typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => p?.text || '').join('') : ''
  )).pop() || '';
  const match = /\[\[(reply|stall|refuse|fail)(?::([^\]]*))?\]\]/.exec(text);
  return match ? { kind: match[1], arg: match[2] ?? '' } : { kind: 'reply', arg: '' };
};

export const startFakeProvider = async ({ model = 'fake-model', defaultReply = 'PONG', port = 0 } = {}) => {
  const requests = [];
  const open = new Set();
  const server = createServer((req, res) => {
    open.add(res);
    res.on('close', () => open.delete(res));
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && /\/models$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'fake' }] }));
        return;
      }
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
        res.writeHead(404); res.end(); return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* answer as default */ }
      const directive = directiveOf(body);
      requests.push({ url: req.url, model: body.model, stream: !!body.stream, directive: directive.kind, authorization: req.headers.authorization ? 'present' : 'absent' });
      if (directive.kind === 'stall') return; // hold the socket open, never answer
      if (directive.kind === 'refuse') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'The request was rejected by the content policy.', type: 'invalid_request_error', code: 'content_policy_violation' } }));
        return;
      }
      if (directive.kind === 'fail') {
        res.writeHead(Number(directive.arg) || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake provider failure', type: 'server_error' } }));
        return;
      }
      const text = directive.arg || defaultReply;
      const id = `chatcmpl-fake-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model || model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
        chunk({ role: 'assistant', content: '' });
        chunk({ content: text });
        chunk({}, 'stop', body.stream_options?.include_usage ? {} : { usage });
        if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model || model, choices: [], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: body.model || model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  return {
    baseURL: `http://127.0.0.1:${bound}/v1`,
    model,
    requests,
    close: () => new Promise((resolve) => { for (const res of open) res.destroy(); server.close(() => resolve()); }),
  };
};
