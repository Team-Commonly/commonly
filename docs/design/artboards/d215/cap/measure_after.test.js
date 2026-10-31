// Run: node --test cap/measure_after.test.js   (no browser, no network)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseArgs, validateTargets, EXPECTED } = require('./measure_after');

const argv = (...a) => ['node', 'measure_after.js', ...a];

test('no argument measures the artboard', () => {
  assert.deepStrictEqual(parseArgs(argv()), { mode: 'artboard', only: null });
});

test('a mistyped mode throws instead of rewriting targets', () => {
  assert.throws(() => parseArgs(argv('prodd')), /unknown mode "prodd"/);
});

test('--only with an unknown surface throws', () => {
  assert.throws(() => parseArgs(argv('prod', '--only', 'unknown')), /unknown surface: unknown/);
  assert.throws(() => parseArgs(argv('prod', '--only', 'chat,nope')), /unknown surface: nope/);
  assert.throws(() => parseArgs(argv('prod', '--only', ',')), /names no surface/);
  assert.throws(() => parseArgs(argv('prod', '--only')), /accepts only/);
  assert.deepStrictEqual(parseArgs(argv('prod', '--only', 'chat,board')), { mode: 'prod', only: ['chat', 'board'] });
});

test('the committed targets.json passes its own validation', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.strictEqual(Object.keys(t).length, 14);
  validateTargets(t);
});

test('an empty or partial measurement is refused', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.throws(() => validateTargets({}), /missing/);
  const partial = { ...t }; delete partial['board-390'];
  assert.throws(() => validateTargets(partial), /missing board-390/);
  assert.throws(() => validateTargets({ ...t, 'chat-1440': { helperWords: NaN, innerRatio: 2 } }), /invalid chat-1440/);
  assert.strictEqual(EXPECTED.length, 14);
});
