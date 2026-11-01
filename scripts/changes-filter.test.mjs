// Regression test for the `changes` job path filter in .github/workflows/tests.yml
// (the tests-slim fast lane). The filter decides which heavy suites a pull_request
// runs; a silently-broken regex would skip a suite for a package it should test.
//
// It reads the THREE `grep -qE '<ere>' && <name>=true` patterns straight out of the
// workflow (no duplication — a reverted regex alternative fails this test) and the
// tests.yml self-test override, then asserts classification for a representative set
// of paths, including every out-of-tree frontend input the filter must catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const yml = readFileSync(join(ROOT, '.github/workflows/tests.yml'), 'utf8');

// Extract `grep -qE '<ere>' && <name>=true` -> { name: RegExp }. ERE here uses only
// features common to ERE and JS regex (^ $ | () escaped-. literal chars), so the
// pattern is used verbatim. Single path tested at a time, so ^/$ are string anchors.
function extractPatterns(text) {
  const out = {};
  const re = /grep -qE '([^']+)'\s*&&\s*(backend|frontend|chart)=true/g;
  let m;
  while ((m = re.exec(text)) !== null) out[m[2]] = new RegExp(m[1]);
  return out;
}
// The self-test override: a tests.yml edit forces every suite to run.
function extractSelfTest(text) {
  const m = text.match(/grep -qE '(\^\\\.github\/workflows\/tests\\\.yml\$)'/);
  assert.ok(m, 'self-test grep pattern not found in workflow');
  return new RegExp(m[1]);
}

const PAT = extractPatterns(yml);
const SELFTEST = extractSelfTest(yml);

test('all three filter patterns were found in the workflow', () => {
  for (const k of ['backend', 'frontend', 'chart']) {
    assert.ok(PAT[k] instanceof RegExp, `missing ${k} pattern`);
  }
});

// Replicates the shell step's logic: classify a changed-file list.
function classify(files) {
  const r = { backend: false, frontend: false, chart: false };
  for (const f of files) {
    if (PAT.backend.test(f)) r.backend = true;
    if (PAT.frontend.test(f)) r.frontend = true;
    if (PAT.chart.test(f)) r.chart = true;
  }
  if (files.some((f) => SELFTEST.test(f))) { r.backend = r.frontend = r.chart = true; }
  return r;
}

// A sample path that is a literal `docs/<path>.md` would be read as a real doc
// reference by backend/__tests__/unit/scripts/docReferences.test.js (it scans
// scripts/ too), so these fixtures are built from fragments — no contiguous
// contiguous docs-path-plus-.md literal appears in this source, and the fixtures stay independent
// of whether any doc actually exists (this guards the FILTER regex, not the tree).
const p = (...s) => s.join('/');

// Each out-of-tree frontend input the filter must catch (the six #3229 added, plus
// the two in-tree roots). A revert of any alternative flips its row and fails here.
const FRONTEND_POSITIVE = [
  'frontend/src/App.tsx',
  'backend/routes/pods.ts',                    // backend also => frontend (shared)
  'README.md',
  p('docs', 'assets', 'readme', 'frame-1.png'),
  p('docs', 'assets', 'landing-source', 'hero.svg'),
  'e2e/byo-offer-layout.spec.ts',
  p('docs', 'adr', 'ADR-040-example.md'),
  p('docs', 'cli', 'opencode.md'),
  p('docs', 'cli', 'dsh.md'),
  'docs-site/introduction.mdx',
  'docs-site/agents/connect.mdx',
  'cli/src/commands/login.js',                 // cli also => frontend
  'commonly-mcp/src/tools.js',
];
for (const f of FRONTEND_POSITIVE) {
  test(`frontend=true for ${f}`, () => {
    assert.equal(classify([f]).frontend, true, `${f} should trigger frontend-tests`);
  });
}

test('frontend=false for an unrelated docs path (not a bare docs/ prefix)', () => {
  assert.equal(classify([p('docs', 'development', 'foo.md')]).frontend, false);
  assert.equal(classify([p('docs', 'runbooks', 'alerting.md')]).frontend, false); // chart-only
});

test('backend filter: backend/, cli/, packages/, root manifest', () => {
  for (const f of ['backend/x.ts', 'cli/src/x.js', 'packages/commonly-apps/src/a.ts', 'package.json', 'package-lock.json']) {
    assert.equal(classify([f]).backend, true, `${f} should trigger backend-tests`);
  }
  assert.equal(classify(['frontend/src/x.tsx']).backend, false);
});

test('chart filter: k8s/, helm/, the three chart-lint script/doc inputs', () => {
  for (const f of ['k8s/helm/commonly/values.yaml', 'helm/x.yaml', 'scripts/verify-backend-worker-chart.sh', 'scripts/monitoring/apply-alerting.py', p('docs', 'runbooks', 'alerting.md')]) {
    assert.equal(classify([f]).chart, true, `${f} should trigger chart-lint`);
  }
  assert.equal(classify(['backend/x.ts']).chart, false);
});

test('a tests.yml edit forces the full matrix (self-test)', () => {
  assert.deepEqual(classify(['.github/workflows/tests.yml']), { backend: true, frontend: true, chart: true });
});

test('README anchor is exact — a nested README path does not match frontend', () => {
  assert.equal(classify([p('docs', 'README.md')]).frontend, false);
});
