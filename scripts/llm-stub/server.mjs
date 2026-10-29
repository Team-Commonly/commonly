#!/usr/bin/env node
// Deterministic OpenAI-compatible chat stub for ./dev.sh up --ephemeral (D177, TASK-620).
// Native agents call LITELLM_BASE_URL/chat/completions; pointing that at this server lets a
// local walk see "agent replies" with no provider key and no quota. The reply text is fixed,
// so a walk can assert on it.
//
//   LLM_STUB_PORT=5102 node scripts/llm-stub/server.mjs

import http from 'node:http';

export const STUB_REPLY = 'Scout stub reply: the local stack answered.';

function completion(model) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: now,
    model: model || 'stub',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: STUB_REPLY },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

export function createStubServer() {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') {
      send(200, { ok: true });
      return;
    }
    if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
      send(200, { object: 'list', data: [{ id: 'stub', object: 'model' }] });
      return;
    }
    if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let model;
        try { model = JSON.parse(raw || '{}').model; } catch { /* a malformed body still gets a reply */ }
        send(200, completion(model));
      });
      return;
    }
    send(404, { error: { message: `no stub route for ${req.method} ${req.url}` } });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.LLM_STUB_PORT || 5102);
  createStubServer().listen(port, '127.0.0.1', () => {
    console.log(`llm stub on 127.0.0.1:${port}`);
  });
}
