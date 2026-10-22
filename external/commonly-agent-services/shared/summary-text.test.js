const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeJsonEnvelope,
  parseJsonBlock,
  salvageSummaryProse,
  podSummaryFromLlmReply,
} = require('./summary-text');

// The reply that produced the bug: the model started its JSON envelope, the
// token cap stopped it mid-sentence, and the whole fragment was stored as the
// pod summary (#2406).
const TRUNCATED = '{"summary":"Chat was mostly status. Rivet landed the deploy fix and Sage is still waiting on a token. Nobody';

test('a truncated envelope is stored as prose, not JSON', () => {
  const result = podSummaryFromLlmReply(TRUNCATED, { messageCount: 12 });
  assert.ok(result, 'expected a summary');
  assert.ok(!result.summary.startsWith('{'), `summary still starts a JSON envelope: ${result.summary}`);
  assert.ok(!looksLikeJsonEnvelope(result.summary));
  assert.ok(result.summary.startsWith('Chat was mostly status.'));
  assert.ok(!result.summary.includes('"summary"'));
  assert.equal(result.messageCount, 12);
});

test('the severed last sentence is dropped rather than shown half-written', () => {
  const result = podSummaryFromLlmReply(TRUNCATED, { messageCount: 12 });
  assert.ok(!result.summary.endsWith('Nobody'));
  assert.ok(result.summary.endsWith('waiting on a token.'));
});

test('a well-formed envelope keeps summary and highlights', () => {
  const raw = JSON.stringify({
    summary: 'Two deploys went out and the board was retriaged.',
    highlights: ['Deploy 4 shipped', 'TASK-331 reopened'],
  });
  const result = podSummaryFromLlmReply(raw, { messageCount: 30 });
  assert.equal(
    result.summary,
    'Two deploys went out and the board was retriaged.\n\nHighlights:\n\n- Deploy 4 shipped\n- TASK-331 reopened',
  );
  assert.ok(!looksLikeJsonEnvelope(result.summary));
});

test('a fenced envelope is unwrapped', () => {
  const raw = '```json\n{"summary":"Quiet window.","highlights":[]}\n```';
  const result = podSummaryFromLlmReply(raw, { messageCount: 5 });
  assert.equal(result.summary, 'Quiet window.\n\nHighlights:\n\n- No major developments in this window.');
});

test('escapes inside the envelope survive salvage', () => {
  const raw = '{"summary":"Sam said \\"ship it\\" and the room moved on.\\nNo blockers. The';
  const result = podSummaryFromLlmReply(raw, { messageCount: 9 });
  assert.ok(result.summary.includes('Sam said "ship it" and the room moved on.'));
  assert.ok(!result.summary.includes('\\n'));
});

test('a reply that ignored the JSON contract is kept as written', () => {
  const result = podSummaryFromLlmReply('Mostly noise: three heartbeats and a merge.', { messageCount: 4 });
  assert.equal(result.summary, 'Mostly noise: three heartbeats and a merge.');
});

test('an envelope with no recoverable prose yields null, not a brace', () => {
  assert.equal(podSummaryFromLlmReply('{"highlights":["a","b"'), null);
  assert.equal(podSummaryFromLlmReply('{'), null);
  assert.equal(podSummaryFromLlmReply('[{"not":"a summary"}]'), null);
  assert.equal(podSummaryFromLlmReply('   '), null);
  assert.equal(podSummaryFromLlmReply(null), null);
});

test('recovered prose is capped and the cap cannot leave a bare brace', () => {
  const long = `{"summary":"${'word '.repeat(400)}`;
  const result = podSummaryFromLlmReply(long, { messageCount: 50 });
  assert.ok(result.summary.length <= 700);
  assert.ok(!looksLikeJsonEnvelope(result.summary));
});

test('salvage and the parser keep their narrow contracts', () => {
  assert.equal(salvageSummaryProse('no json here'), null);
  assert.equal(salvageSummaryProse('{"summary":"  "}'), null);
  assert.deepEqual(parseJsonBlock('prefix {"summary":"x"} suffix'), { summary: 'x' });
  assert.equal(parseJsonBlock('not json'), null);
  assert.equal(looksLikeJsonEnvelope('plain prose'), false);
  assert.equal(looksLikeJsonEnvelope('  {"summary"'), true);
});
