import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLastWalked, parseDate } from '../check-docs-last-walked.js';

const RUN = '2026-10-28';
const PAGE = 'quickstart.mdx';

// Age in days of a walk date relative to RUN, built from the same clock the script uses.
const daysBefore = (n) => new Date(Date.parse(`${RUN}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

test('a page with no sidecar entry warns', () => {
  const w = checkLastWalked({ pages: [PAGE], walked: {}, runDate: RUN });
  assert.equal(w.length, 1);
  assert.equal(w[0].page, PAGE);
  assert.match(w[0].message, /no walk date/);
});

test('a walk 29 days before the run date is ok', () => {
  const w = checkLastWalked({ pages: [PAGE], walked: { [PAGE]: daysBefore(29) }, runDate: RUN });
  assert.deepEqual(w, []);
});

test('a walk exactly 30 days before the run date is still ok', () => {
  const w = checkLastWalked({ pages: [PAGE], walked: { [PAGE]: daysBefore(30) }, runDate: RUN });
  assert.deepEqual(w, []);
});

test('a walk 31 days before the run date warns and names the age', () => {
  const w = checkLastWalked({ pages: [PAGE], walked: { [PAGE]: daysBefore(31) }, runDate: RUN });
  assert.equal(w.length, 1);
  assert.match(w[0].message, /31 days before 2026-10-28 \(limit 30\)/);
});

test('a sidecar entry that names no page warns', () => {
  const w = checkLastWalked({ pages: [PAGE], walked: { 'gone.mdx': RUN, [PAGE]: RUN }, runDate: RUN });
  assert.equal(w.length, 1);
  assert.equal(w[0].page, 'gone.mdx');
  assert.match(w[0].message, /not a docs-site page/);
});

test('a date that is not a real YYYY-MM-DD warns instead of passing silently', () => {
  const w = checkLastWalked({ pages: [PAGE], walked: { [PAGE]: '2026-02-30' }, runDate: RUN });
  assert.equal(w.length, 1);
  assert.match(w[0].message, /not a real YYYY-MM-DD/);
});

test('parseDate rejects a non-date and accepts a real one', () => {
  assert.equal(parseDate('10/28/2026'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.notEqual(parseDate('2026-10-28'), null);
});

test('a bad run date throws rather than checking against NaN', () => {
  assert.throws(() => checkLastWalked({ pages: [], walked: {}, runDate: 'today' }), /run date must be YYYY-MM-DD/);
});
