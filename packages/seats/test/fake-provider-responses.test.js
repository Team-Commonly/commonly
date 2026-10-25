// OpenAI Responses: the documented event sequence, the Response object, errors,
// and reading tool results back out of `input`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { post, parseSSE } from './fake-provider-helpers.js';

const HEADERS = { authorization: 'Bearer sk-test' };

test('responses stream: reasoning, message and function_call items in the documented event order', async () => {
  const fake = await startFakeProvider({ script: [{ thought: 'hmm', text: ['a', 'b'], toolCalls: [{ name: 'exec_command', arguments: { cmd: 'ls' } }] }] });
  try {
    const res = await post(`${fake.baseURL}/responses`, { model: 'm', stream: true, input: 'go' }, HEADERS);
    const events = parseSSE(await res.text());
    for (const e of events) assert.equal(e.event, e.data.type);
    assert.deepEqual(events.map((e) => e.data.sequence_number), events.map((_, i) => i), 'sequence_number rises from 0');
    assert.deepEqual(events.map((e) => e.event), [
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.delta',
      'response.function_call_arguments.done', 'response.output_item.done',
      'response.completed',
    ]);
    assert.equal(events[0].data.response.status, 'in_progress');
    const args = events.filter((e) => e.event === 'response.function_call_arguments.delta').map((e) => e.data.delta).join('');
    assert.equal(args, events.find((e) => e.event === 'response.function_call_arguments.done').data.arguments);
    assert.deepEqual(JSON.parse(args), { cmd: 'ls' });
    const done = events.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item);
    const completed = events.at(-1).data.response;
    assert.deepEqual(completed.output, done, 'the completed response carries exactly the finished items');
    assert.equal(completed.status, 'completed');
    assert.deepEqual(Object.keys(completed.usage).sort(), ['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens']);
    const fc = done.find((i) => i.type === 'function_call');
    assert.match(fc.call_id, /^call_/);
    assert.match(fc.id, /^fc_/);
  } finally { await fake.close(); }
});

test('responses non-stream: a Response object with output items and usage', async () => {
  const fake = await startFakeProvider({ script: ['hello'] });
  try {
    const r = await (await post(`${fake.baseURL}/responses`, { model: 'm', input: 'go' }, HEADERS)).json();
    assert.equal(r.object, 'response');
    assert.equal(r.status, 'completed');
    assert.deepEqual(r.output, [{ type: 'message', id: 'msg_fake_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }]);
    assert.equal(r.usage.total_tokens, r.usage.input_tokens + r.usage.output_tokens);
  } finally { await fake.close(); }
});

test('responses: max_tokens is response.incomplete with a reason; a refusal error is a 400', async () => {
  const fake = await startFakeProvider({ script: [{ text: 'cut', stop: 'max_tokens' }, { refuse: true, refuseAs: 'error' }, { error: 429 }] });
  try {
    const events = parseSSE(await (await post(`${fake.baseURL}/responses`, { stream: true, input: 'go' }, HEADERS)).text());
    assert.equal(events.at(-1).event, 'response.incomplete');
    assert.deepEqual(events.at(-1).data.response.incomplete_details, { reason: 'max_output_tokens' });
    const refused = await post(`${fake.baseURL}/responses`, { input: 'go' }, HEADERS);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'content_policy_violation');
    const limited = await post(`${fake.baseURL}/responses`, { input: 'go' }, HEADERS);
    assert.equal(limited.status, 429);
    assert.deepEqual((await limited.json()).error, { message: 'fake provider failure', type: 'invalid_request_error', param: null, code: 'rate_limit_exceeded' });
  } finally { await fake.close(); }
});

test('responses: function_call_output items are read as the tool results of the previous turn', async () => {
  const fake = await startFakeProvider({ script: [{ toolCalls: [{ name: 'exec_command', arguments: { cmd: 'ls' } }] }, 'done'] });
  try {
    const first = await (await post(`${fake.baseURL}/responses`, { input: 'go' }, HEADERS)).json();
    const call = first.output[0];
    const input = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      call,
      { type: 'function_call_output', call_id: call.call_id, output: 'file-a\nfile-b' },
    ];
    const second = await (await post(`${fake.baseURL}/responses`, { input }, HEADERS)).json();
    assert.equal(second.output[0].content[0].text, 'done');
    assert.deepEqual(fake.requests[1].toolResults, [{ callId: call.call_id, output: 'file-a\nfile-b', isError: false, name: 'exec_command' }]);
    assert.deepEqual(fake.toolResults, [{ request: 1, callId: call.call_id, output: 'file-a\nfile-b', isError: false, name: 'exec_command' }]);
  } finally { await fake.close(); }
});
