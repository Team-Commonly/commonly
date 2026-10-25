// Anthropic Messages: the exact stream sequence, the bodies, and the error shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { post, parseSSE } from './fake-provider-helpers.js';

const HEADERS = { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' };
const body = (extra = {}) => ({ model: 'claude-x', max_tokens: 64, messages: [{ role: 'user', content: 'go' }], ...extra });

test('anthropic stream: thinking, text and tool_use blocks in the documented event order', async () => {
  const fake = await startFakeProvider({ script: [{ thought: 'hmm', text: ['a', 'b'], toolCalls: [{ name: 'Read', arguments: { file_path: '/x' } }] }] });
  try {
    const res = await post(`${fake.anthropicBaseURL}/v1/messages`, body({ stream: true }), HEADERS);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('request-id'), 'req_fake_1');
    const events = parseSSE(await res.text());
    for (const e of events) assert.equal(e.event, e.data.type, 'the SSE event name matches data.type');
    const seq = events.map((e) => (e.data.delta?.type ? `${e.event}:${e.data.delta.type}` : e.event));
    assert.deepEqual(seq, [
      'message_start', 'ping',
      'content_block_start', 'content_block_delta:thinking_delta', 'content_block_delta:signature_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta:text_delta', 'content_block_delta:text_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta:input_json_delta', 'content_block_delta:input_json_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    const start = events[0].data.message;
    assert.equal(start.role, 'assistant');
    assert.deepEqual(start.content, []);
    assert.equal(start.stop_reason, null);
    assert.equal(start.model, 'claude-x');
    assert.equal(typeof start.usage.input_tokens, 'number');
    assert.deepEqual(events.filter((e) => e.event === 'content_block_start').map((e) => [e.data.index, e.data.content_block.type]), [[0, 'thinking'], [1, 'text'], [2, 'tool_use']]);
    const tool = events.find((e) => e.data.content_block?.type === 'tool_use').data.content_block;
    assert.deepEqual(tool.input, {}, 'tool input starts empty and arrives as JSON fragments');
    const json = events.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(json), { file_path: '/x' });
    const delta = events.find((e) => e.event === 'message_delta').data;
    assert.equal(delta.delta.stop_reason, 'tool_use');
    assert.equal(typeof delta.usage.output_tokens, 'number');
  } finally { await fake.close(); }
});

test('anthropic non-stream: a Message with blocks, stop reason and usage', async () => {
  const fake = await startFakeProvider({ script: [{ thought: 'hmm', text: 'hi' }] });
  try {
    const res = await post(`${fake.anthropicBaseURL}/v1/messages`, body(), HEADERS);
    const msg = await res.json();
    assert.equal(msg.type, 'message');
    assert.match(msg.id, /^msg_/);
    assert.deepEqual(msg.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(typeof msg.content[0].signature, 'string');
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(msg.stop_sequence, null);
    assert.deepEqual(Object.keys(msg.usage).sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
  } finally { await fake.close(); }
});

test('anthropic refusal: in-band stop_reason by default, a 400 content-filter error on request', async () => {
  const fake = await startFakeProvider({ script: [{ refuse: true }, { refuse: 'x', refuseAs: 'error' }] });
  try {
    const inband = await (await post(`${fake.anthropicBaseURL}/v1/messages`, body(), HEADERS)).json();
    assert.equal(inband.stop_reason, 'refusal');
    assert.equal(inband.stop_details.type, 'refusal');
    const res = await post(`${fake.anthropicBaseURL}/v1/messages`, body(), HEADERS);
    assert.equal(res.status, 400);
    const err = await res.json();
    assert.equal(err.type, 'error');
    assert.deepEqual(err.error, { type: 'invalid_request_error', message: 'Output blocked by content filtering policy' });
    assert.equal(err.request_id, 'req_fake_2');
  } finally { await fake.close(); }
});

test('anthropic errors: each status maps to its documented error type', async () => {
  const statuses = [400, 401, 403, 404, 429, 500, 529];
  const fake = await startFakeProvider({ script: statuses.map((status) => ({ error: status })) });
  try {
    const types = [];
    for (const status of statuses) {
      const res = await post(`${fake.anthropicBaseURL}/v1/messages`, body(), HEADERS);
      assert.equal(res.status, status);
      types.push((await res.json()).error.type);
    }
    assert.deepEqual(types, ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'api_error', 'overloaded_error']);
  } finally { await fake.close(); }
});

test('anthropic: [[fail:529]] answers overloaded, and an error turn can carry headers', async () => {
  const fake = await startFakeProvider({ script: [{ error: { status: 429, headers: { 'retry-after': '7' } } }] });
  try {
    const limited = await post(`${fake.anthropicBaseURL}/v1/messages`, body(), HEADERS);
    assert.equal(limited.headers.get('retry-after'), '7');
    const res = await post(`${fake.anthropicBaseURL}/v1/messages`, body({ messages: [{ role: 'user', content: 'x [[fail:529]]' }] }), HEADERS);
    assert.equal(res.status, 529);
    assert.equal((await res.json()).error.type, 'overloaded_error');
  } finally { await fake.close(); }
});

test('anthropic: count_tokens answers without advancing the script, and both auth styles are recorded', async () => {
  const fake = await startFakeProvider({ script: ['first'] });
  try {
    const count = await (await post(`${fake.anthropicBaseURL}/v1/messages/count_tokens`, body(), HEADERS)).json();
    assert.equal(typeof count.input_tokens, 'number');
    assert.equal(fake.scriptPosition, 0);
    const msg = await (await post(`${fake.anthropicBaseURL}/v1/messages?beta=true`, body(), { authorization: 'Bearer oauth-ish' })).json();
    assert.equal(msg.content[0].text, 'first');
    assert.deepEqual(fake.requests.map((r) => r.auth), [{ header: 'authorization', scheme: 'Bearer' }]);
    assert.equal(fake.allRequests[0].path, '/v1/messages/count_tokens');
    assert.equal(fake.allRequests[0].auth, undefined, 'count_tokens is not a model call');
    assert.equal(fake.allRequests[0].headers['x-api-key'], '[redacted]');
    assert.equal(fake.requests[0].path, '/v1/messages');
  } finally { await fake.close(); }
});
