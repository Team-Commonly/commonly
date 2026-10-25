// In-band refusal detection, read from real fake-provider response bytes in
// all three wire formats, streamed and not, plus the refusal_dropped settle rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { WIRES, post, parseSSE } from './fake-provider-helpers.js';
import {
  REFUSAL_FORMATS, refusalSignalsOf, findRefusal, createRefusalTap, refusalDropped, MAX_JSON_BYTES,
} from '../src/wire/refusal.js';
import { FAILURE_KINDS, RunFailure } from '../src/failures.js';
import * as seats from '../src/index.js';

const REFUSAL_TEXT = 'I can’t help with that.'; // the fake provider's default; ’ is 3 UTF-8 bytes
const FORMAT_OF_WIRE = { anthropic: 'anthropic', responses: 'openai-responses', chat: 'openai-chat' };

/** POST one scripted turn and return the raw response bytes and content type. */
const fetchRaw = async (fake, wire, stream) => {
  const w = WIRES[wire];
  const res = await post(w.path(fake), w.body('go', stream), w.headers);
  return { status: res.status, contentType: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
};

/** Feed bytes through a tap in fixed-size chunks, so frames and UTF-8 sequences split. */
const tapInChunks = (bytes, size, opts) => {
  const tap = createRefusalTap(opts);
  for (let i = 0; i < bytes.length; i += size) tap.write(bytes.subarray(i, i + size));
  tap.end();
  return tap;
};

for (const wire of Object.keys(WIRES)) {
  for (const stream of [false, true]) {
    const name = `${wire} ${stream ? 'stream' : 'non-stream'}`;

    test(`${name}: an in-band refusal is detected, with its text, at any chunk size`, async () => {
      const fake = await startFakeProvider({ script: [{ refuse: true, refuseAs: 'inband' }] });
      try {
        const { status, bytes, contentType } = await fetchRaw(fake, wire, stream);
        assert.equal(status, 200, 'an in-band refusal is a 200');
        for (const size of [1, 2, 7, 64, bytes.length]) {
          const sniffed = tapInChunks(bytes, size);
          assert.equal(sniffed.refusal?.format, FORMAT_OF_WIRE[wire], `chunk ${size}`);
          if (wire === 'chat' && !stream) assert.equal(sniffed.refusal.signal, 'message.refusal');
          assert.equal(sniffed.refusal.text, REFUSAL_TEXT, `chunk ${size}: the refusal text survives split UTF-8`);
          assert.deepEqual(tapInChunks(bytes, size, { contentType }).refusal, sniffed.refusal, 'content type and sniffing agree');
        }
        // The pure function over parsed events reaches the same answer.
        const events = stream ? parseSSE(bytes.toString('utf8')).map((e) => e.data) : [JSON.parse(bytes.toString('utf8'))];
        assert.deepEqual(findRefusal(events), tapInChunks(bytes, 64).refusal);
      } finally { await fake.close(); }
    });

    test(`${name}: an ordinary reply, text or tool call, carries no refusal`, async () => {
      const fake = await startFakeProvider({
        script: ['hello there', { thought: 'hmm', toolCalls: [{ name: 'exec_command', arguments: { cmd: 'ls' } }] }, { text: 'cut', stop: 'max_tokens' }],
      });
      try {
        for (let turn = 0; turn < 3; turn += 1) {
          const { status, bytes } = await fetchRaw(fake, wire, stream);
          assert.equal(status, 200);
          assert.equal(tapInChunks(bytes, 5).refusal, null, `turn ${turn}`);
        }
      } finally { await fake.close(); }
    });

    test(`${name}: a refusal sent as an HTTP error is not an in-band refusal`, async () => {
      // The CLI already fails on a 4xx; this detector is for the 200 it can swallow.
      const fake = await startFakeProvider({ script: [{ refuse: true, refuseAs: 'error' }] });
      try {
        const { status, bytes } = await fetchRaw(fake, wire, stream);
        assert.equal(status, 400);
        assert.equal(tapInChunks(bytes, 5).refusal, null);
      } finally { await fake.close(); }
    });
  }
}

test('[[refuse]] in the prompt: the default shape is in-band for Messages and Responses only', async () => {
  const fake = await startFakeProvider();
  try {
    for (const wire of Object.keys(WIRES)) {
      const w = WIRES[wire];
      const res = await post(w.path(fake), w.body('[[refuse]]', true), w.headers);
      const tap = tapInChunks(Buffer.from(await res.arrayBuffer()), 9);
      assert.equal(!!tap.refusal, wire !== 'chat', wire);
    }
  } finally { await fake.close(); }
});

test('the documented provider shapes the fake does not emit are recognised too', () => {
  const cases = [
    // Anthropic: a whole message, and a stop_details-only delta.
    [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial' }], stop_reason: 'refusal' }, 'anthropic', 'stop_reason'],
    [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_details: { type: 'refusal', explanation: 'no' } } }, 'anthropic', 'stop_reason'],
    [{ type: 'content_block_start', index: 0, content_block: { type: 'refusal', text: 'no' } }, 'anthropic', 'refusal_block'],
    // Responses: the finished item alone, and a content-filtered incomplete.
    [{ type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] } }, 'openai-responses', 'refusal_part'],
    [{ type: 'response.incomplete', response: { object: 'response', output: [], incomplete_details: { reason: 'content_filter' } } }, 'openai-responses', 'content_filter'],
    // Chat: the refusal finish reasons, streamed and whole.
    [{ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }, 'openai-chat', 'finish_reason'],
    [{ object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'refusal' }] }, 'openai-chat', 'finish_reason'],
  ];
  for (const [event, format, signal] of cases) {
    const [first] = refusalSignalsOf(event);
    assert.deepEqual({ format: first?.format, signal: first?.signal }, { format, signal }, JSON.stringify(event));
  }
  assert.equal(findRefusal([cases[0][0]]).text, '', 'a stop reason with no explanation is a refusal with empty text');
  assert.equal(findRefusal([cases[1][0]]).text, 'no');
});

test('fields that only look like refusals are not refusals', () => {
  const quiet = [
    { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi', refusal: null }, finish_reason: null }] },
    { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'refusal', refusal: '' }, finish_reason: 'stop' }] },
    { type: 'response.output_text.delta', delta: 'refusal' },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_details: null } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'stop_reason: refusal' } },
    { type: 'error', error: { type: 'invalid_request_error', message: 'refusal' } },
    null, 'refusal', 42, [],
  ];
  for (const event of quiet) assert.deepEqual(refusalSignalsOf(event), [], JSON.stringify(event));
  assert.equal(findRefusal(quiet), null);
  assert.equal(findRefusal(undefined), null);
});

test('the tap reads CRLF frames, multi-line data and a final frame with no blank line', () => {
  const tap = createRefusalTap();
  tap.write(': keep-alive\r\n\r\nevent: response.refusal.delta\r\ndata: {"type":"response.refusal.delta",\r\n');
  tap.write('data: "delta":"no"}\r\n\r\ndata: [DONE]');
  tap.end();
  assert.deepEqual(tap.refusal, { format: 'openai-responses', signal: 'refusal_part', text: 'no' });
});

test('the tap stops reading a JSON body past its cap', () => {
  const tap = createRefusalTap({ contentType: 'application/json' });
  tap.write(`{"object":"chat.completion","pad":"${'x'.repeat(MAX_JSON_BYTES)}",`);
  tap.end('"choices":[{"message":{"refusal":"no"}}]}');
  assert.equal(tap.overflowed, true);
  assert.equal(tap.refusal, null);
});

test('refusal_dropped is a named, never-retried failure kind', () => {
  assert.equal(FAILURE_KINDS.refusal_dropped.retryable, false);
  assert.ok(FAILURE_KINDS.refusal_dropped.meaning);
  assert.deepEqual([...REFUSAL_FORMATS], ['anthropic', 'openai-responses', 'openai-chat']);
  assert.equal(seats.refusalDropped, refusalDropped);
  assert.equal(seats.createRefusalTap, createRefusalTap);
});

test('refusalDropped: a refusal on the wire and a clean, silent exit settle as refusal_dropped', async () => {
  const fake = await startFakeProvider({ script: ['looking', { refuse: true, refuseAs: 'inband' }] });
  try {
    // Two requests in one run, as a tool loop makes: the second one refuses.
    const refusals = [];
    for (let i = 0; i < 2; i += 1) refusals.push(tapInChunks((await fetchRaw(fake, 'responses', true)).bytes, 11).refusal);
    assert.equal(refusals[0], null);

    for (const result of [{ text: '' }, { text: 'looking' }, {}, undefined]) {
      const failure = refusalDropped({ refusals, result });
      assert.ok(failure instanceof RunFailure, JSON.stringify(result));
      assert.equal(failure.kind, 'refusal_dropped');
      assert.equal(failure.retryable, false);
      assert.match(failure.detail, /openai-responses refusal_part, 23 chars/);
      assert.equal(failure.refusal.text, REFUSAL_TEXT);
    }
    // The CLI passed the refusal through: nothing was dropped.
    assert.equal(refusalDropped({ refusals, result: { text: `The model said: ${REFUSAL_TEXT}` } }), null);
    // No refusal seen: a clean run is left alone, empty or not.
    assert.equal(refusalDropped({ refusals: [null], result: { text: '' } }), null);
    assert.equal(refusalDropped({ result: { text: '' } }), null);
  } finally { await fake.close(); }
});

test('refusalDropped: a refusal with no text cannot be shown as surfaced by any reply', () => {
  const refusal = findRefusal([{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]);
  assert.equal(refusal.text, '');
  assert.equal(refusalDropped({ refusals: [refusal], result: { text: 'anything' } }).kind, 'refusal_dropped');
  assert.equal(refusalDropped({ refusals: refusal, result: { text: '' } }).kind, 'refusal_dropped', 'one refusal, not an array');
});
