import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs scripts/gate-verdict.sh with a fake `gh` on PATH. The fake answers the two REST
// calls from JSON fixtures and applies the script's own --jq filter with jq, so the
// filter the workflow ships is the one under test.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'gate-verdict.sh');
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${FAKE_GH_FAIL:-}" ]; then echo "HTTP 500" >&2; exit 1; fi
path=""; expr=""
while [ $# -gt 0 ]; do
  case "$1" in
    api|--paginate) shift ;;
    --jq) expr="$2"; shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  */files) fixture="$FAKE_FILES" ;;
  */reviews) fixture="$FAKE_REVIEWS" ;;
  *) echo "unexpected path: $path" >&2; exit 2 ;;
esac
jq -r "$expr" "$fixture"
`;

const bin = mkdtempSync(join(tmpdir(), 'gate-verdict-gh-'));
writeFileSync(join(bin, 'gh'), FAKE_GH);
chmodSync(join(bin, 'gh'), 0o755);
after(() => rmSync(bin, { recursive: true, force: true }));

let nextId = 1000;
const review = (body, { login = 'lilyshen0722', commit = HEAD, state = 'COMMENTED' } = {}) =>
  ({ id: nextId++, user: { login }, commit_id: commit, state, submitted_at: '2026-10-31T07:30:00Z', body });
const PASS = 'Checked out HEAD and ran the focused tests.\n\nGATE: PASS';
const FAIL = 'Found a defect in the rollback path.\n\nGATE: FAIL';

const CODE_FILES = ['backend/services/byoHandoffService.ts'];
const TIER0_FILES = [
  'docs/development/external-review.md',
  'backend/__tests__/unit/services/byoHandoffService.test.ts',
  'CLAUDE.md',
];

function run({ files = [], reviews = [], env = {} } = {}) {
  const fixtures = mkdtempSync(join(tmpdir(), 'gate-verdict-fx-'));
  try {
    const filesPath = join(fixtures, 'files.json');
    const reviewsPath = join(fixtures, 'reviews.json');
    writeFileSync(filesPath, JSON.stringify(files.map((filename) => ({ filename }))));
    writeFileSync(reviewsPath, JSON.stringify(reviews));
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        REPO: 'Team-Commonly/commonly',
        PR_NUMBER: '3050',
        HEAD_SHA: HEAD,
        FAKE_FILES: filesPath,
        FAKE_REVIEWS: reviewsPath,
        ...env,
      },
    });
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
}

test('docs and test files only are Tier 0: no verdict needed', () => {
  const r = run({ files: TIER0_FILES });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Tier 0/);
});

test('a dot-directory markdown file is not docs: it needs a gate', () => {
  assert.equal(run({ files: ['.github/PULL_REQUEST_TEMPLATE.md', '.claude/skills/x/SKILL.md'] }).status, 1);
});

test('one code file among docs and tests still needs a gate', () => {
  const r = run({ files: [...TIER0_FILES, ...CODE_FILES] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no GATE verdict from lilyshen0722/);
});

test('an empty file list is not Tier 0', () => {
  assert.equal(run({ files: [] }).status, 1);
});

test('a code PR with no verdict is blocked', () => {
  const r = run({ files: CODE_FILES });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no GATE verdict/);
});

test('a GATE: PASS from the gate account at the head passes', () => {
  const r = run({ files: CODE_FILES, reviews: [review(PASS)] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`GATE: PASS at ${HEAD}`));
});

test('the account match ignores case', () => {
  assert.equal(run({ files: CODE_FILES, reviews: [review(PASS, { login: 'LilyShen0722' })] }).status, 0);
});

test('a PASS at an older head does not count', () => {
  assert.equal(run({ files: CODE_FILES, reviews: [review(PASS, { commit: OLD })] }).status, 1);
});

test('a PASS from another account does not count, CodeRabbit included', () => {
  const reviews = [review(PASS, { login: 'coderabbitai' }), review(PASS, { login: 'sharpen-bot' })];
  assert.equal(run({ files: CODE_FILES, reviews }).status, 1);
});

test('GATE: PASS must be the last line of the review', () => {
  assert.equal(run({ files: CODE_FILES, reviews: [review('GATE: PASS\n\nFollow-up: none.')] }).status, 1);
});

test('trailing spaces and CRLF on the last line are ignored', () => {
  assert.equal(run({ files: CODE_FILES, reviews: [review('ran the tests\r\n\r\nGATE: PASS  \r\n')] }).status, 0);
});

test('a FAIL after a PASS at the same head blocks it', () => {
  const r = run({ files: CODE_FILES, reviews: [review(PASS), review(FAIL)] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /is 'GATE: FAIL'/);
});

test('a PASS after a FAIL at the same head passes', () => {
  assert.equal(run({ files: CODE_FILES, reviews: [review(FAIL), review(PASS)] }).status, 0);
});

test('a dismissed PASS does not count', () => {
  assert.equal(run({ files: CODE_FILES, reviews: [review(PASS, { state: 'DISMISSED' })] }).status, 1);
});

test('an API failure fails closed', () => {
  const r = run({ files: CODE_FILES, reviews: [review(PASS)], env: { FAKE_GH_FAIL: '1' } });
  assert.notEqual(r.status, 0);
});
