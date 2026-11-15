// The internal-labels guard reads a PR's added lines only. These pin what it
// refuses, and the look-alikes (hex colours, ADR decision numbers, one-digit
// ids, names that only contain the letters) it must let through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLabels, parseAllowlist } from './check-internal-labels.mjs';

const diff = (file, ...added) => [
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -1,0 +1,3 @@',
  ...added.map((line) => `+${line}`),
].join('\n');

// Fixture paths under docs/ are built from parts: the doc-reference check
// scans every file for docs/<name>.md and would read a written-out fixture as
// a dead pointer (see backend/__tests__/unit/scripts/docReferences.test.js).
const doc = (...parts) => ['docs', ...parts].join('/');

const tokens = (text, allow) => findLabels(text, allow).map((hit) => hit.token);

test('a ledger id in a comment or a string is refused', () => {
  assert.deepEqual(tokens(diff('backend/services/a.ts', '// D215: the press waits for review')), ['D215']);
  assert.deepEqual(tokens(diff('cli/src/b.js', "const why = 'per D45, sign in';")), ['D45']);
  assert.deepEqual(tokens(diff(doc('runbooks', 'c.md'), 'Sam asked for this (D308).')), ['D308']);
});

test('the team-internal role name is refused, in any case', () => {
  assert.deepEqual(tokens(diff(doc('adr', 'ADR-030-x.md'), 'Ratified by the Cofounder on 11-15.')), ['Cofounder']);
  assert.deepEqual(tokens(diff('frontend/src/v2/a.tsx', '// cofounder ruling: keep it')), ['cofounder']);
});

test('hex colours, ADR decision numbers and one-digit ids pass', () => {
  assert.deepEqual(tokens(diff('frontend/src/v2/v2.css',
    'color: #D12;',
    'background: #D215AA;',
    'mask: 0xD215;')), []);
  assert.deepEqual(tokens(diff(doc('adr', 'ADR-024-x.md'),
    'This amends ADR-018 D12 and ADR-024 D9.2.',
    'See D9 above.')), []);
  assert.deepEqual(tokens(diff('backend/services/a.ts', 'const D2D = renderD3(1);', 'const id = "AD215B";')), []);
});

// ADR decisions top out at D13 today; ledger rows run past D300. Below D20 is
// an ADR's own numbering ("### D10", "predates D17"), and stays allowed.
test('an ADR-local decision number below D20 passes; D20 and up is refused', () => {
  assert.deepEqual(tokens(diff(doc('adr', 'ADR-025-x.md'), '### D10 — Inbound routing', '// Legacy binds predate D17.')), []);
  assert.deepEqual(tokens(diff('backend/services/a.ts', '// D20 says so')), ['D20']);
});

test('spreadsheet cell references and vendored skills pass', () => {
  assert.deepEqual(tokens(diff(doc('x.md'), 'get "/Sheet1/A1:D40"', 'formula: (1+D$54)/C$55', 'ref=D25:H29')), []);
  assert.deepEqual(tokens(diff('backend/commonly-bundled-skills/officecli/SKILL.md', 'Cell D214 is the anchor')), []);
});

test('only added lines are read, and paths outside the scope pass', () => {
  const text = [
    'diff --git a/backend/a.ts b/backend/a.ts',
    '--- a/backend/a.ts',
    '+++ b/backend/a.ts',
    '@@ -1,2 +1,1 @@',
    '-// D215 removed here',
    ' // D245 context line already on main',
    '+// a plain reason',
  ].join('\n');
  assert.deepEqual(tokens(text), []);
  assert.deepEqual(tokens(diff('scripts/x.mjs', '// D215')), []);
  assert.deepEqual(tokens(diff('CLAUDE.md', 'Cofounder')), []);
  assert.deepEqual(tokens(diff('cli/__tests__/x.test.mjs', '// D215')), []);
  assert.deepEqual(tokens(diff('frontend/node_modules/x/index.js', '// D215')), []);
});

test('a hit names its file and line', () => {
  const [hit] = findLabels([
    'diff --git a/packages/seats/src/a.js b/packages/seats/src/a.js',
    '--- a/packages/seats/src/a.js',
    '+++ b/packages/seats/src/a.js',
    '@@ -10,0 +11,2 @@',
    '+const ok = 1;',
    '+// D278: why',
  ].join('\n'));
  assert.equal(hit.file, 'packages/seats/src/a.js');
  assert.equal(hit.line, 12);
});

test('two ids joined by a slash are both refused', () => {
  assert.deepEqual(tokens(diff('backend/a.ts', '// per D243/D244')), ['D243', 'D244']);
});

test('the role name is matched as a word, hyphenated too, not inside another word', () => {
  assert.deepEqual(tokens(diff(doc('a.md'), 'the co-founder said')), ['co-founder']);
  assert.deepEqual(tokens(diff('frontend/src/a.tsx', "const cofounders = 'x';")), []);
});

test('an added line that reads like a file header stays inside its hunk', () => {
  const text = [
    `diff --git a/${doc('a.md')} b/${doc('a.md')}`,
    `--- a/${doc('a.md')}`,
    `+++ b/${doc('a.md')}`,
    '@@ -0,0 +1,3 @@',
    '+++ counter',
    '+// D215',
    '+// D216',
  ].join('\n');
  assert.deepEqual(tokens(text), ['D215', 'D216']);
});

test('an allowlist entry lets one token through in one file only', () => {
  const allow = parseAllowlist('# real hits\nfrontend/src/v2/a.tsx D100\n\n');
  assert.deepEqual(tokens(diff('frontend/src/v2/a.tsx', "label: 'D100 series'"), allow), []);
  assert.deepEqual(tokens(diff('frontend/src/v2/b.tsx', "label: 'D100 series'"), allow), ['D100']);
  assert.deepEqual(tokens(diff('frontend/src/v2/a.tsx', '// D215'), allow), ['D215']);
});
