// Scripts and inline directives: one turn per request across every format, tool
// results surfaced from the next request, and the phase-aware tool directive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, parseDirectives } from '../test-support/fake-provider.js';
import { ask, post, probe, parseSSE, WIRES } from './fake-provider-helpers.js';

test('a script advances one turn per model request, across formats, then falls back to directives', async () => {
  const fake = await startFakeProvider({ script: ['one', 'two', 'three'] });
  try {
    assert.equal((await ask(fake, 'anthropic')).text, 'one');
    assert.equal((await ask(fake, 'responses', { stream: true })).text, 'two');
    assert.equal((await ask(fake, 'chat')).text, 'three');
    assert.equal((await ask(fake, 'chat', { prompt: '[[reply:after]]' })).text, 'after');
    assert.equal((await ask(fake, 'anthropic')).text, 'PONG');
    assert.deepEqual(fake.requests.map((r) => r.scriptTurn), [0, 1, 2, null, null]);
    assert.deepEqual(fake.requests.map((r) => r.format), ['anthropic', 'openai-responses', 'openai-chat', 'openai-chat', 'anthropic']);
    assert.equal(fake.scriptPosition, 3);
  } finally { await fake.close(); }
});

test('a tool call, then the next request carries its result: the provider exposes it with the tool name', async () => {
  const fake = await startFakeProvider({
    script: [
      { toolCalls: [{ name: 'Read', arguments: { file_path: '/n' } }] },
      // A function entry sees the request it answers, tool results included.
      (request) => ({ text: `saw ${request.toolResults.map((r) => `${r.name}=${r.output}`).join(',')}` }),
    ],
  });
  try {
    const url = `${fake.anthropicBaseURL}/v1/messages`;
    const first = await (await post(url, { messages: [{ role: 'user', content: 'go' }] })).json();
    const use = first.content.find((b) => b.type === 'tool_use');
    const second = await (await post(url, {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: first.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: [{ type: 'text', text: 'NOTE' }], is_error: true }] },
        { role: 'system', content: [{ type: 'text', text: 'a reminder appended after the result' }] },
      ],
    })).json();
    assert.equal(second.content[0].text, 'saw Read=NOTE');
    assert.deepEqual(fake.toolResults, [{ request: 1, callId: use.id, output: 'NOTE', isError: true, name: 'Read' }]);
    assert.deepEqual(fake.requests[0].toolCalls, [{ id: use.id, name: 'Read' }]);
    assert.deepEqual(fake.toolCalls, [{ request: 0, id: use.id, name: 'Read', arguments: { file_path: '/n' } }]);
  } finally { await fake.close(); }
});

test('chat: tool messages are read as results of the assistant tool_calls', async () => {
  const fake = await startFakeProvider({ script: [{ toolCalls: [{ name: 'f', arguments: '{"a":1}' }] }, 'ok'] });
  try {
    const url = `${fake.baseURL}/chat/completions`;
    const first = await (await post(url, { messages: [{ role: 'user', content: 'go' }] })).json();
    const msg = first.choices[0].message;
    assert.equal(msg.tool_calls[0].function.arguments, '{"a":1}', 'string arguments pass through untouched');
    await post(url, { messages: [{ role: 'user', content: 'go' }, msg, { role: 'tool', tool_call_id: msg.tool_calls[0].id, content: 'R' }] });
    assert.deepEqual(fake.requests[1].toolResults, [{ callId: msg.tool_calls[0].id, output: 'R', isError: false, name: 'f' }]);
  } finally { await fake.close(); }
});

test('a script can come from a JSON file, be swapped with setScript, and skip requests a filter rejects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-provider-'));
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify([{ text: 'from-file' }]));
  const fake = await startFakeProvider({ script: file, scriptFilter: (r) => r.body.max_tokens !== 1 });
  try {
    // A one-token probe (the kind a CLI sends to check quota) must not eat the script.
    const probeRes = await (await post(`${fake.anthropicBaseURL}/v1/messages`, { max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] })).json();
    assert.equal(probeRes.content[0].text, 'PONG');
    assert.equal((await ask(fake, 'anthropic')).text, 'from-file');
    fake.setScript(['swapped']);
    assert.equal(fake.scriptPosition, 0);
    assert.equal((await ask(fake, 'chat')).text, 'swapped');
  } finally { await fake.close(); }
});

test('directive [[tool:name:{json}]] asks for the tool once, then the result request gets the reply', async () => {
  const fake = await startFakeProvider();
  try {
    const prompt = 'x [[tool:Read:{"file_path":"/a]]b"}]] [[tool:Glob:{"pattern":"*"}]] [[reply:FINISHED]] [[think:why]]';
    const url = `${fake.baseURL}/responses`;
    const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] };
    const first = await (await post(url, { input: [user] })).json();
    const calls = first.output.filter((i) => i.type === 'function_call');
    assert.deepEqual(calls.map((c) => [c.name, JSON.parse(c.arguments)]), [['Read', { file_path: '/a]]b' }], ['Glob', { pattern: '*' }]]);
    assert.equal(first.output[0].type, 'reasoning');
    const results = calls.map((c) => ({ type: 'function_call_output', call_id: c.call_id, output: 'r' }));
    const second = await (await post(url, { input: [user, ...calls, ...results] })).json();
    assert.deepEqual(second.output.map((i) => i.type), ['message']);
    assert.equal(second.output[0].content[0].text, 'FINISHED');
    assert.deepEqual(fake.requests.map((r) => r.directive), ['tool', 'reply']);
    assert.equal(fake.requests[1].toolResults.length, 2);
  } finally { await fake.close(); }
});

test('directive parsing: legacy precedence holds, tool JSON may contain ]], cut takes a mode', () => {
  assert.equal(parseDirectives('[[reply:A]] [[stall]]').kind, 'reply');
  assert.equal(parseDirectives('[[stall]] [[reply:A]]').kind, 'stall');
  assert.deepEqual(parseDirectives('[[fail:503]]'), { kind: 'fail', arg: '503', reply: null, thought: null, cut: null, toolCalls: [] });
  assert.deepEqual(parseDirectives('[[tool:t:{"a":"]]","b":[1,{"c":"}"}]}]]').toolCalls, [{ name: 't', arguments: { a: ']]', b: [1, { c: '}' }] } }]);
  assert.deepEqual(parseDirectives('[[tool:bare]]').toolCalls, [{ name: 'bare', arguments: {} }]);
  assert.deepEqual(parseDirectives('[[tool:bad:{nope]]').toolCalls, [], 'invalid JSON is not a tool call');
  assert.deepEqual(parseDirectives('[[cut:3]]').cut, { after: 3, mode: 'silent' });
  assert.deepEqual(parseDirectives('[[cut:0:close]]').cut, { after: 0, mode: 'close' });
});

test('directive [[cut:N]] works inline on every format', async () => {
  const fake = await startFakeProvider();
  try {
    for (const wire of Object.keys(WIRES)) {
      const w = WIRES[wire];
      const silent = await probe(w.path(fake), w.body('[[cut:1]]', true), { waitMs: 100, headers: w.headers });
      assert.equal(silent.how, 'silent', wire);
      assert.equal(parseSSE(silent.text).length, 1, wire);
      const closed = await probe(w.path(fake), w.body('[[cut:1:close]]', true), { waitMs: 500, headers: w.headers });
      assert.equal(closed.how, 'closed', wire);
    }
  } finally { await fake.close(); }
});
