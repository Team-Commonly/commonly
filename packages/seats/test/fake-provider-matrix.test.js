// Every wire format x stream/non-stream x scripted behaviour, read back the way
// a client would read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { WIRES, ask, probe, parseSSE } from './fake-provider-helpers.js';

const STOPS = {
  anthropic: { end: 'end_turn', tool: 'tool_use', max: 'max_tokens' },
  responses: { end: 'completed', tool: 'completed', max: 'incomplete' },
  chat: { end: 'stop', tool: 'tool_calls', max: 'length' },
};

const withFake = async (script, fn) => {
  const fake = await startFakeProvider({ script });
  try { return await fn(fake); } finally { await fake.close(); }
};

for (const wire of Object.keys(WIRES)) {
  for (const stream of [false, true]) {
    const label = `${wire} ${stream ? 'stream' : 'non-stream'}`;

    test(`${label}: text arrives whole and ends the turn`, () => withFake([{ text: ['Hel', 'lo'] }], async (fake) => {
      const r = await ask(fake, wire, { stream });
      assert.equal(r.status, 200);
      assert.equal(r.text, 'Hello');
      assert.deepEqual(r.tools, []);
      assert.equal(r.stop, STOPS[wire].end);
      if (stream && wire !== 'chat') assert.ok(r.events.filter((e) => /text_delta|output_text\.delta/.test(JSON.stringify(e.data.delta?.type ?? e.data.type))).length >= 2, 'one delta per chunk');
    }));

    test(`${label}: a tool call carries its name and joined arguments`, () => withFake(
      [{ toolCalls: [{ name: 'read_file', arguments: { path: 'a]]b', n: 1 } }, { name: 'list', arguments: {} }] }],
      async (fake) => {
        const r = await ask(fake, wire, { stream });
        assert.equal(r.status, 200);
        assert.deepEqual(r.tools.map(({ name, arguments: a }) => ({ name, arguments: a })), [
          { name: 'read_file', arguments: { path: 'a]]b', n: 1 } },
          { name: 'list', arguments: {} },
        ]);
        assert.equal(new Set(r.tools.map((t) => t.id)).size, 2, 'distinct call ids');
        assert.equal(r.stop, STOPS[wire].tool);
        assert.deepEqual(fake.toolCalls.map((c) => c.name), ['read_file', 'list']);
      },
    ));

    test(`${label}: a thought precedes the answer`, () => withFake([{ thought: 'pondering', text: 'ok' }], async (fake) => {
      const r = await ask(fake, wire, { stream });
      assert.equal(r.thought, 'pondering');
      assert.equal(r.text, 'ok');
    }));

    test(`${label}: a refusal uses the format's own refusal shape`, () => withFake([{ refuse: 'no thanks' }], async (fake) => {
      const r = await ask(fake, wire, { stream });
      if (wire === 'chat') {
        assert.equal(r.status, 400);
        assert.equal(r.error.error.code, 'content_policy_violation');
      } else {
        assert.equal(r.status, 200);
        assert.equal(r.refusal, 'no thanks');
        assert.equal(r.text, '');
        if (wire === 'anthropic') assert.equal(r.stop, 'refusal');
      }
      assert.equal(fake.requests[0].directive, 'refuse');
    }));

    test(`${label}: an HTTP error comes back in the format's error body`, () => withFake([{ error: 529 }], async (fake) => {
      const r = await ask(fake, wire, { stream });
      assert.equal(r.status, 529);
      if (wire === 'anthropic') {
        assert.deepEqual({ ...r.error, request_id: undefined }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: undefined });
      } else {
        assert.equal(r.error.error.type, 'server_error');
      }
      assert.equal(fake.requests[0].directive, 'fail');
    }));

    test(`${label}: max_tokens stops the turn as truncated`, () => withFake([{ text: 'abc', stop: 'max_tokens' }], async (fake) => {
      const r = await ask(fake, wire, { stream });
      assert.equal(r.stop, STOPS[wire].max);
      assert.equal(r.text, 'abc');
    }));

    test(`${label}: a stall accepts the request and sends nothing`, () => withFake([{ stall: true }], async (fake) => {
      const w = WIRES[wire];
      const r = await probe(w.path(fake), w.body('go', stream), { waitMs: 150, headers: w.headers });
      assert.equal(r.how, 'silent');
      assert.equal(r.status, null);
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].directive, 'stall');
    }));

    for (const mode of ['silent', 'close']) {
      test(`${label}: a ${mode} cut after 2 sends exactly 2 then ${mode === 'close' ? 'drops the socket' : 'goes quiet'}`, () => withFake(
        [{ text: ['a', 'b', 'c', 'd'], cut: { after: 2, mode } }],
        async (fake) => {
          const w = WIRES[wire];
          const r = await probe(w.path(fake), w.body('go', stream), { waitMs: 150, headers: w.headers });
          assert.equal(r.status, 200);
          assert.equal(r.how, mode === 'close' ? 'closed' : 'silent');
          if (stream) assert.equal(parseSSE(r.text).length, 2);
          else assert.equal(r.text.length, 2);
          assert.equal(fake.requests[0].directive, 'cut');
        },
      ));
    }
  }

  test(`${wire} stream: an in-stream error ends the stream the format's way`, () => withFake(
    [{ text: 'partial', error: { status: 529, inStream: true } }],
    async (fake) => {
      const r = await ask(fake, wire, { stream: true });
      assert.equal(r.status, 200);
      assert.equal(r.text, 'partial');
      const last = r.events[r.events.length - 1];
      if (wire === 'anthropic') {
        assert.equal(last.event, 'error');
        assert.equal(last.data.error.type, 'overloaded_error');
      } else if (wire === 'responses') {
        assert.equal(last.event, 'response.failed');
        assert.equal(last.data.response.status, 'failed');
      } else {
        assert.ok(last.data.error);
        assert.ok(!r.events.some((e) => e.data === '[DONE]'));
      }
    },
  ));
}
