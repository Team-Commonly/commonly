// Regression test for the guard-name canary's exit-code routing in
// .github/workflows/deploy-dev.yml. The canary step maps its script's exit code to a
// deploy outcome: 3 = the live injection guard blocked the turn -> fail the step so the
// rollback step fires; 1 (kubectl/node error) and 2 (inconclusive) = warn only, step
// succeeds, no rollback; 0 = pass. A silent edit — 3 changed to 2, the sole `exit 1`
// dropped, or the rollback clause removed — would turn a real guard block into a green
// deploy, which is exactly the regression this guards. It reads the logic straight out of
// the workflow (no duplication), the same approach as changes-filter.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const yml = readFileSync(join(ROOT, '.github/workflows/deploy-dev.yml'), 'utf8');

// Extract one step's block: from its `- name: <name>` line to the next step's `- name:`.
function stepBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found in deploy-dev.yml`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*- name: /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

const canary = stepBlock(yml, 'Guard-name canary');

test('the canary step carries id: canary (the rollback condition references it)', () => {
  assert.match(canary, /^\s*id:\s*canary\s*$/m);
});

test('only exit code 3 hard-fails the canary step', () => {
  // 3 -> the step exits nonzero (fails) so failure() holds and rollback fires.
  assert.match(canary, /if\s*\[\s*"\$CODE"\s*=\s*3\s*\]\s*;\s*then/);
  // The CODE=3 branch is the ONLY path that exits nonzero. Any other nonzero exit
  // would fail the step for an inconclusive/error code and trip a spurious rollback.
  const nonzeroExits = (canary.match(/^\s*exit\s+[1-9][0-9]*\s*$/gm) || []).map((s) => s.trim());
  assert.deepEqual(nonzeroExits, ['exit 1'],
    'canary must have exactly one nonzero exit (inside the CODE=3 branch)');
});

test('exit codes 1 and 2 are warn-only (no rollback)', () => {
  // A single `if [ "$CODE" != 0 ]` warn branch catches 1 and 2 without exiting nonzero.
  assert.match(canary, /if\s*\[\s*"\$CODE"\s*!=\s*0\s*\]\s*;\s*then/);
  assert.match(canary, /::warning title=Guard-name canary inconclusive/);
});

test('the rollback step fires on a canary failure', () => {
  const rb = stepBlock(yml, 'Roll back on a failed deploy');
  assert.match(rb, /failure\(\)\s*&&/);
  assert.match(rb, /steps\.canary\.outcome\s*==\s*'failure'/);
});

test('a guard-blocked release is never recorded as rollout-verified', () => {
  // The record step is `if: success()`, so a failed canary skips it and the next
  // rollback returns to the last genuinely-verified revision, not this blocked one.
  const rec = stepBlock(yml, 'Record this release as rollout-verified (rollback target)');
  assert.match(rec, /^\s*if:\s*success\(\)\s*$/m);
});
