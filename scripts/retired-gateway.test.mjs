// ADR-021 Part B retired the OpenClaw gateway. A chart template or deploy
// workflow that names it again would either nil-pointer the render (the values
// are gone) or start building and rolling a workload nobody runs.
//   node --test scripts/retired-gateway.test.mjs
// RETIRED_GATEWAY_ROOT points the scan at another git checkout, to prove it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RETIRED_GATEWAY_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..');
const RETIRED = /agents\.clawdbot|clawdbot-gateway|_external\/clawdbot/;

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

const hits = (files) => files.flatMap((file) => readFileSync(file, 'utf8')
  .split('\n')
  .flatMap((line, i) => (RETIRED.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : [])));

test('no chart template names the retired gateway', () => {
  const templates = walk(join(ROOT, 'k8s/helm/commonly/templates'));
  assert.ok(templates.length > 20, `scanned only ${templates.length} templates`);
  assert.deepEqual(hits(templates), []);
});

test('no deploy workflow names the retired gateway', () => {
  const workflows = ['deploy-dev.yml', 'deploy-staging.yml']
    .map((name) => join(ROOT, '.github/workflows', name));
  assert.deepEqual(hits(workflows), []);
});

// A test that reads a deleted template fails with ENOENT, far from the deletion.
// Docs may keep the history; code, config and tests may not name these files.
const DELETED = /clawdbot-deployment\.yaml|clawdbot-service\.yaml|clawdbot-(config|workspace)-pvc\.yaml|filestore-storageclass\.yaml|agent-provisioning\/pvc\.yaml|verify-moltbot-tool-contract|moltbotToolContract/;

test('no tracked file outside docs names a deleted file', () => {
  const { status, stdout, stderr } = spawnSync('git', [
    'grep', '-n', '-I', '-E', DELETED.source.replaceAll('\\/', '/'),
    '--', '.', ':!docs', ':!*.md', ':!scripts/retired-gateway.test.mjs',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(status === 0 || status === 1, `git grep failed: ${stderr}`);
  assert.equal(stdout, '');
});

test('the pattern catches what it is for', () => {
  for (const line of ['{{- if .Values.agents.clawdbot.enabled }}', 'key: clawdbot-gateway-token', 'docker build _external/clawdbot']) {
    assert.match(line, RETIRED);
  }
  assert.match("'templates/agents/clawdbot-deployment.yaml',", DELETED);
});
