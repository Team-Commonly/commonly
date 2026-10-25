// OpenAI Responses `previous_response_id`: stored responses, chained context,
// the real API's not-found error, and capture of which id chained to which.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { post, parseSSE } from './fake-provider-helpers.js';

const HEADERS = { authorization: 'Bearer sk-test' };
const userMsg = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

test('responses chaining: a follow-up carrying only the tool output continues the stored turn', async () => {
  const fake = await startFakeProvider();
  try {
    const url = `${fake.baseURL}/responses`;
    const first = await (await post(url, { model: 'm', input: [userMsg('go [[tool:exec_command:{"cmd":"ls"}]] [[reply:AFTER-TOOL]]')] }, HEADERS)).json();
    assert.equal(first.id, 'resp_fake_1');
    assert.equal(first.previous_response_id, null);
    assert.equal(first.store, true);
    const call = first.output.find((i) => i.type === 'function_call');
    // The prompt and its directives live only in the stored turn now.
    const second = await (await post(url, {
      model: 'm', previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'a\nb' }],
    }, HEADERS)).json();
    assert.equal(second.previous_response_id, first.id);
    assert.equal(second.output[0].content[0].text, 'AFTER-TOOL');
    assert.deepEqual(fake.requests[1].toolResults, [{ callId: call.call_id, output: 'a\nb', isError: false, name: 'exec_command' }], 'the call name resolves through the chain');
    assert.equal(fake.requests[1].priorItems, 2, 'the prior user message and function_call');
    assert.deepEqual(fake.chains, [{ request: 1, from: 'resp_fake_1', to: 'resp_fake_2', found: true }]);
    assert.deepEqual(fake.requests.map((r) => [r.previousResponseId, r.responseId]), [[null, 'resp_fake_1'], ['resp_fake_1', 'resp_fake_2']]);
  } finally { await fake.close(); }
});

test('responses chaining: context accumulates across three turns, so the first prompt still drives the third', async () => {
  const fake = await startFakeProvider();
  try {
    const url = `${fake.baseURL}/responses`;
    const prompt = 'go [[tool:a:{}]] [[tool:b:{}]] [[reply:THIRD]]';
    // The fake asks for both tools at once; answer them in two separate chained requests.
    const r1 = await (await post(url, { input: [userMsg(prompt)], stream: true }, HEADERS)).text();
    const done1 = parseSSE(r1).at(-1).data.response;
    const [ca, cb] = done1.output.filter((i) => i.type === 'function_call');
    const r2 = await (await post(url, { previous_response_id: done1.id, input: [{ type: 'function_call_output', call_id: ca.call_id, output: 'A' }] }, HEADERS)).json();
    assert.equal(r2.output[0].content[0].text, 'THIRD', 'one tool round seen through the chain');
    const r3 = await (await post(url, { previous_response_id: r2.id, input: [userMsg('again [[reply:FOURTH]]'), { type: 'function_call_output', call_id: cb.call_id, output: 'B' }] }, HEADERS)).json();
    assert.equal(r3.output[0].content[0].text, 'FOURTH', 'a new user message in the chain becomes the prompt');
    assert.equal(fake.requests[2].priorItems, 5, 'user message, two calls, one output, the reply message');
    assert.deepEqual(fake.chains.map((c) => `${c.from}->${c.to}`), ['resp_fake_1->resp_fake_2', 'resp_fake_2->resp_fake_3']);
  } finally { await fake.close(); }
});

test('responses chaining: an unknown id is the real API 400 previous_response_not_found, and uses no script turn', async () => {
  const fake = await startFakeProvider({ script: ['SCRIPTED'] });
  try {
    const url = `${fake.baseURL}/responses`;
    const res = await post(url, { previous_response_id: 'resp_missing', input: 'hi' }, HEADERS);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: {
        message: "Previous response with id 'resp_missing' not found.",
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    });
    assert.equal(fake.requests[0].directive, 'fail');
    assert.deepEqual(fake.chains, [{ request: 0, from: 'resp_missing', to: null, found: false }]);
    assert.equal(fake.scriptPosition, 0);
    const ok = await (await post(url, { input: 'hi' }, HEADERS)).json();
    assert.equal(ok.output[0].content[0].text, 'SCRIPTED');
  } finally { await fake.close(); }
});

test('responses chaining: store:false responses are not kept, so chaining to one is not found', async () => {
  const fake = await startFakeProvider();
  try {
    const url = `${fake.baseURL}/responses`;
    const first = await (await post(url, { store: false, input: 'hi' }, HEADERS)).json();
    assert.equal(first.store, false);
    assert.deepEqual(fake.storedResponseIds, []);
    const res = await post(url, { previous_response_id: first.id, input: 'more' }, HEADERS);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'previous_response_not_found');
  } finally { await fake.close(); }
});

test('responses chaining: failed and stalled responses are never stored', async () => {
  const fake = await startFakeProvider({ script: [{ error: 500 }, { text: 'x', error: { status: 500, inStream: true } }] });
  try {
    const url = `${fake.baseURL}/responses`;
    await post(url, { input: 'hi' }, HEADERS);
    await (await post(url, { input: 'hi', stream: true }, HEADERS)).text();
    assert.deepEqual(fake.storedResponseIds, []);
  } finally { await fake.close(); }
});
