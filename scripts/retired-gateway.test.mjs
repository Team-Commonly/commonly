// ADR-021 Part B retired the OpenClaw gateway. A chart template or deploy
// workflow that names it again would either nil-pointer the render (the values
// are gone) or start building and rolling a workload nobody runs.
//   node --test scripts/retired-gateway.test.mjs
// RETIRED_GATEWAY_ROOT points the scan at another git checkout, to prove it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RETIRED_GATEWAY_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..');
const RETIRED = /agents\.clawdbot|clawdbot-gateway|_external\/clawdbot|CLAWDBOT_GATEWAY_URL|MOLTBOT_GATEWAY_URL|CLAWDBOT_IMAGE|CLAWDBOT_GATEWAY_TOKEN/;

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
  for (const line of ['{{- if .Values.agents.clawdbot.enabled }}', 'key: clawdbot-gateway-token', 'docker build _external/clawdbot', '- name: CLAWDBOT_GATEWAY_URL', '- name: MOLTBOT_GATEWAY_URL', '- name: CLAWDBOT_IMAGE', '- name: CLAWDBOT_GATEWAY_TOKEN']) {
    assert.match(line, RETIRED);
  }
  assert.match("'templates/agents/clawdbot-deployment.yaml',", DELETED);
});

test('dev.sh stops the old containers by name, and only stops them', () => {
  const bin = mkdtempSync(join(tmpdir(), 'retired-gateway-'));
  const log = join(bin, 'docker.log');
  // A docker that reports every container running and records what it is asked.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = ps ] && echo abc123\nexit 0\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  try {
    const run = spawnSync('bash', [join(ROOT, 'dev.sh'), 'clawdbot'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /retired/);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /^stop clawdbot-gateway-dev$/m);
    assert.match(calls, /^stop clawdbot-cli-dev$/m);
    assert.doesNotMatch(calls, /\b(rm|prune|volume)\b|-v\b/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
