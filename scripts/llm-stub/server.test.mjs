// Run: node --test scripts/llm-stub/server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStubServer, STUB_REPLY } from './server.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('chat completions return the fixed reply in OpenAI shape, every time', async () => {
  const server = createStubServer();
  const port = await listen(server);
  try {
    const body = JSON.stringify({ model: 'scout', messages: [{ role: 'user', content: 'hi' }] });
    const call = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }).then((r) => r.json());
    const first = await call();
    const second = await call();
    assert.equal(first.object, 'chat.completion');
    assert.equal(first.choices[0].message.role, 'assistant');
    assert.equal(first.choices[0].message.content, STUB_REPLY);
    assert.equal(first.choices[0].finish_reason, 'stop');
    assert.equal(second.choices[0].message.content, first.choices[0].message.content);
    assert.equal(first.model, 'scout');
  } finally {
    server.close();
  }
});

test('models list and unknown routes', async () => {
  const server = createStubServer();
  const port = await listen(server);
  try {
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then((r) => r.json());
    assert.equal(models.data[0].id, 'stub');
    const missing = await fetch(`http://127.0.0.1:${port}/v1/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
