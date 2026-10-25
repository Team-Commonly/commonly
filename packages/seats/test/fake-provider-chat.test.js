// OpenAI chat completions: the bodies older checks depend on stay exactly as
// they were, and the new tool-call stream follows the chunked tool_calls shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { post, parseSSE } from './fake-provider-helpers.js';

const user = (content) => ({ messages: [{ role: 'user', content }] });

test('chat: the refusal and failure bodies are unchanged', async () => {
  const fake = await startFakeProvider();
  try {
    const url = `${fake.baseURL}/chat/completions`;
    const refused = await post(url, user('[[refuse]]'));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: { message: 'The request was rejected by the content policy.', type: 'invalid_request_error', code: 'content_policy_violation' } });
    const failed = await post(url, user('[[fail:503]]'));
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: { message: 'fake provider failure', type: 'server_error' } });
    assert.deepEqual(fake.requests.map((r) => r.directive), ['refuse', 'fail']);
  } finally { await fake.close(); }
});

test('chat stream: include_usage sends a trailing usage chunk, then [DONE]', async () => {
  const fake = await startFakeProvider();
  try {
    const events = parseSSE(await (await post(`${fake.baseURL}/chat/completions`, { ...user('hi'), stream: true, stream_options: { include_usage: true } })).text());
    assert.equal(events.at(-1).data, '[DONE]');
    const usage = events.at(-2).data;
    assert.deepEqual(usage.choices, []);
    assert.equal(usage.usage.total_tokens, usage.usage.prompt_tokens + usage.usage.completion_tokens);
    assert.equal(events.at(-3).data.choices[0].finish_reason, 'stop');
    assert.equal(events.at(-3).data.usage, undefined);
  } finally { await fake.close(); }
});

test('chat stream: a tool call opens with id and name, then streams arguments by index', async () => {
  const fake = await startFakeProvider({ script: [{ toolCalls: [{ name: 'f', arguments: { q: 'long-ish value' } }] }] });
  try {
    const events = parseSSE(await (await post(`${fake.baseURL}/chat/completions`, { ...user('hi'), stream: true })).text());
    const deltas = events.filter((e) => e.data.choices?.[0]?.delta?.tool_calls).map((e) => e.data.choices[0].delta.tool_calls[0]);
    assert.equal(deltas[0].id, 'call_fake_1_0');
    assert.equal(deltas[0].function.name, 'f');
    assert.equal(deltas[0].function.arguments, '');
    assert.ok(deltas.slice(1).every((d) => d.index === 0 && d.id === undefined));
    assert.deepEqual(JSON.parse(deltas.map((d) => d.function.arguments).join('')), { q: 'long-ish value' });
  } finally { await fake.close(); }
});
