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

// Reasoning the way DeepSeek- and OpenRouter-compatible chat servers send it.
test('chat non-stream: [[think:X]] puts X in message.reasoning_content beside the answer', async () => {
  const fake = await startFakeProvider();
  try {
    const j = await (await post(`${fake.baseURL}/chat/completions`, user('q [[think:weighing it up]] [[reply:ANSWER]]'))).json();
    const m = j.choices[0].message;
    assert.equal(m.reasoning_content, 'weighing it up');
    assert.equal(m.content, 'ANSWER');
    assert.equal(j.choices[0].finish_reason, 'stop');
    const plain = await (await post(`${fake.baseURL}/chat/completions`, user('q [[reply:ANSWER]]'))).json();
    assert.equal('reasoning_content' in plain.choices[0].message, false, 'no thought, no field');
  } finally { await fake.close(); }
});

test('chat stream: [[think:X]] streams delta.reasoning_content chunks that join to X, all before any content', async () => {
  const fake = await startFakeProvider();
  try {
    const events = parseSSE(await (await post(`${fake.baseURL}/chat/completions`, { ...user('q [[think:weighing it up]] [[reply:ANSWER]]'), stream: true })).text());
    const deltas = events.filter((e) => e.data.choices?.[0]).map((e) => e.data.choices[0].delta);
    const reasoningAt = deltas.flatMap((d, i) => (d.reasoning_content ? [i] : []));
    assert.ok(reasoningAt.length >= 2, 'reasoning arrives in more than one delta');
    assert.equal(reasoningAt.map((i) => deltas[i].reasoning_content).join(''), 'weighing it up');
    const contentAt = deltas.flatMap((d, i) => (d.content ? [i] : []));
    assert.ok(Math.max(...reasoningAt) < Math.min(...contentAt), 'reasoning precedes content');
    assert.equal(contentAt.map((i) => deltas[i].content).join(''), 'ANSWER');
    assert.ok(deltas.every((d) => !(d.reasoning_content && d.content)), 'a delta carries one or the other');
  } finally { await fake.close(); }
});

test('chat: [[think:X]] with a tool directive reasons on the tool turn only, then answers without it', async () => {
  const fake = await startFakeProvider();
  try {
    const url = `${fake.baseURL}/chat/completions`;
    const prompt = 'q [[think:plan]] [[tool:lookup:{"k":1}]] [[reply:DONE]]';
    const first = await (await post(url, user(prompt))).json();
    const m1 = first.choices[0].message;
    assert.equal(m1.reasoning_content, 'plan');
    assert.equal(m1.tool_calls[0].function.name, 'lookup');
    const followUp = { messages: [{ role: 'user', content: prompt }, m1, { role: 'tool', tool_call_id: m1.tool_calls[0].id, content: 'v' }] };
    const second = await (await post(url, followUp)).json();
    assert.equal(second.choices[0].message.content, 'DONE');
    assert.equal(second.choices[0].message.reasoning_content, undefined);
  } finally { await fake.close(); }
});
