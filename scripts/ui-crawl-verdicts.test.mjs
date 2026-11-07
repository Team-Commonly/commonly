import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  captureProblem, clickOutcome, needsReload, resolveCandidate, stripAge, untranslatedStrings, withOccurrences,
} from './ui-crawl-verdicts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = { clicked: true, writesRefused: 0, readsRefused: 0, navigated: false, mutated: false, requested: false };

test('a control is found after an earlier control removes itself from the list', () => {
  const before = withOccurrences([
    { index: 0, label: 'Resend' }, { index: 1, label: 'Hide reminder' },
    { index: 2, label: 'Connect' }, { index: 3, label: 'Connect' },
  ]);
  const after = withOccurrences([{ index: 0, label: 'Connect' }, { index: 1, label: 'Connect' }]);
  assert.equal(resolveCandidate(after, before[3]).index, 1);
  assert.equal(resolveCandidate(after, before[0]), null);
});

test('a row keeps its name when its age ticks over', () => {
  assert.equal(stripAge('Docs 5h'), 'Docs');
  assert.equal(stripAge('Top 10'), 'Top 10');
  const [before] = withOccurrences([{ index: 0, label: 'Docs 5h' }]);
  const after = withOccurrences([{ index: 3, label: 'Docs 6h' }]);
  assert.equal(resolveCandidate(after, before).index, 3);
});

test('a native dialog is a response, not a dead control', () => {
  assert.equal(clickOutcome({ ...base, dialog: true }), 'dialog');
  assert.equal(clickOutcome({ ...base, dialog: true, writesRefused: 1 }), 'write-refused');
  assert.equal(needsReload('dialog'), false);
});

test('English left in a Chinese string is reported, and the kept names are not', () => {
  assert.deepEqual(untranslatedStrings(['在 GitHub 上打开', '同一个 Pod 中', 'CLI 设备', '设备']), []);
  assert.deepEqual(untranslatedStrings(['Revoke', '撤销 Devices']), ['Revoke', '撤销 Devices']);
});

test('a refused write outranks everything else the click did', () => {
  assert.equal(clickOutcome({ ...base, writesRefused: 1, navigated: true }), 'write-refused');
});

test('a refused read qualifies an outcome and does not replace it', () => {
  assert.equal(clickOutcome({ ...base, navigated: true, readsRefused: 2 }), 'navigated+read-refused');
  assert.equal(clickOutcome({ ...base, readsRefused: 1 }), 'dead+read-refused');
});

test('a click that did nothing is dead', () => {
  assert.equal(clickOutcome(base), 'dead');
  assert.equal(clickOutcome({ ...base, clicked: false }), 'unclickable');
});

test('any click that may have changed the page reloads it', () => {
  for (const outcome of ['navigated', 'changed', 'requested', 'write-refused', 'dead+read-refused']) {
    assert.equal(needsReload(outcome), true, outcome);
  }
  for (const outcome of ['dead', 'stale', 'unclickable']) assert.equal(needsReload(outcome), false, outcome);
});

test('a page with no controls is refused, not passed with zero dead clicks', () => {
  assert.match(captureProblem({ candidateCount: 0, clicks: [] }), /no controls/);
  assert.match(captureProblem({ candidateCount: null, clicks: [] }), /no controls/);
});

test('a capture that is mostly stale is refused', () => {
  const clicks = [
    { outcome: 'write-refused' }, { outcome: 'changed' },
    ...Array.from({ length: 10 }, () => ({ outcome: 'stale' })),
  ];
  assert.equal(captureProblem({ candidateCount: 12, clicks }), 'only 2 of 12 clicks got a verdict');
});

test('repeats are not counted against a capture', () => {
  const clicks = [{ outcome: 'navigated' }, ...Array.from({ length: 9 }, () => ({ outcome: 'repeat' }))];
  assert.equal(captureProblem({ candidateCount: 10, clicks }), null);
  assert.equal(captureProblem({ candidateCount: 3, clicks: clicks.slice(1, 4) }), null);
});

test('the route list names no route the app redirects away from', () => {
  const routes = JSON.parse(readFileSync(join(here, 'ui-crawl-routes.json'), 'utf8'));
  const paths = routes.map((r) => r.path);
  for (const gone of ['/v2/agents/manage', '/v2/settings/devices', '/v2/profile']) {
    assert.equal(paths.includes(gone), false, gone);
  }
});
