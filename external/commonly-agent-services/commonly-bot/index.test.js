const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLlmPodSummary, handleEvent } = require('./index');

const messages = [
  { username: 'Sam', content: 'The deploy fix landed.' },
  { username: 'Rivet', content: 'The token blocker remains open.' },
];

const fakeClient = (reply) => ({
  baseUrl: 'fake-llm',
  chat: async (...args) => {
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(...args) : reply;
  },
});

const runSummaryRequest = async (reply) => {
  const originalFetch = global.fetch;
  const writes = [];
  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/messages?limit=30')) return { ok: true, json: async () => ({ messages }) };
    if (url.endsWith('/context')) return { ok: true, json: async () => ({ pod: { name: 'Sharpen' } }) };
    if (url.endsWith('/summaries')) {
      writes.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({}) };
    }
    if (url.endsWith('/events/event-1/ack')) {
      writes.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await handleEvent(
      { runtimeToken: 'test-token' },
      { _id: 'event-1', type: 'summary.request', podId: 'pod-1', payload: { silent: true } },
      { summaryClient: fakeClient(reply) },
    );
    return writes;
  } finally {
    global.fetch = originalFetch;
  }
};

test('buildLlmPodSummary turns a complete model reply into prose', async () => {
  const summary = await buildLlmPodSummary({
    messages,
    podName: 'Sharpen',
    client: fakeClient((_system, prompt, options) => {
      assert.match(prompt, /Sam: The deploy fix landed\./);
      assert.equal(options.maxTokens, 900);
      return '{"summary":"The deploy fix landed.","highlights":["Token blocker remains"]}';
    }),
  });
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.summary, 'The deploy fix landed.\n\nHighlights:\n\n- Token blocker remains');
});

test('summary.request persists a complete LLM summary before acknowledging', async () => {
  const writes = await runSummaryRequest(
    '{"summary":"The deploy fix landed.","highlights":["Token blocker remains"]}',
  );
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.summary, 'The deploy fix landed.\n\nHighlights:\n\n- Token blocker remains');
  assert.equal(writes[0].body.eventId, 'event-1');
  assert.ok(writes[1].url.endsWith('/events/event-1/ack'));
});

test('summary.request stores recovered prose when the model reply ends mid-envelope', async () => {
  const writes = await runSummaryRequest(
    '{"summary":"The deploy fix landed. The token blocker remains open. Nobody',
  );
  assert.equal(writes.length, 2);
  assert.ok(writes[0].url.endsWith('/summaries'));
  assert.equal(writes[0].body.summary, 'The deploy fix landed. The token blocker remains open.');
  assert.ok(!writes[0].body.summary.startsWith('{'));
  assert.ok(!writes[0].body.summary.includes('"summary"'));
  assert.equal(writes[0].body.messageCount, 2);
  assert.ok(writes[1].url.endsWith('/events/event-1/ack'));
});

test('summary.request stores heuristic prose and acknowledges after an LLM error', async () => {
  const writes = await runSummaryRequest(new Error('LLM unavailable'));
  assert.equal(writes.length, 2);
  assert.ok(writes[0].url.endsWith('/summaries'));
  assert.match(writes[0].body.summary, /^A quick update from Sharpen:/);
  assert.match(writes[0].body.summary, /The deploy fix landed\./);
  assert.ok(writes[1].url.endsWith('/events/event-1/ack'));
});
