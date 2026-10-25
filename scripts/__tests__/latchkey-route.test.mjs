import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROBE_JOB, backstop, budgetDecision, holdActive, probeState, route, runsSince, stuckJobs,
} from '../latchkey-route.mjs';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();
const job = (name, status, labels, createdSecAgo = 0) => ({ name, status, labels, created_at: ago(createdSecAgo) });

test('a hold is fresh only inside its window and never when expired', () => {
  assert.equal(holdActive([{ created_at: ago(30 * 60), expired: false }], NOW, 60), true);
  assert.equal(holdActive([{ created_at: ago(61 * 60), expired: false }], NOW, 60), false);
  assert.equal(holdActive([{ created_at: ago(60), expired: true }], NOW, 60), false);
  assert.equal(holdActive([], NOW, 60), false);
});

test('the budget counts runs since the start and stops at 80% of the free minutes', () => {
  const start = '2026-10-26T00:00:00Z';
  const artifacts = [{ created_at: '2026-10-25T23:59:00Z' }, { created_at: '2026-10-26T00:00:00Z' }, { created_at: ago(10) }];
  assert.equal(runsSince(artifacts, start), 2);
  assert.deepEqual(budgetDecision({ runs: 249, eqPerRun: 32, budgetEqMin: 10000 }), { used: 7968, limit: 8000, ok: true });
  assert.equal(budgetDecision({ runs: 250, eqPerRun: 32, budgetEqMin: 10000 }).ok, false);
  // A zero budget is the rehearsal for spent minutes.
  assert.equal(budgetDecision({ runs: 0, eqPerRun: 32, budgetEqMin: 0 }).ok, false);
});

test('probe state reads the probe job only', () => {
  assert.equal(probeState([]), 'missing');
  assert.equal(probeState([job(PROBE_JOB, 'queued', ['latchkey-small'])]), 'queued');
  assert.equal(probeState([job(PROBE_JOB, 'in_progress', ['latchkey-small'])]), 'started');
  assert.equal(probeState([job(PROBE_JOB, 'completed', ['latchkey-small'])]), 'started');
});

test('only heavy Latchkey jobs queued past the limit count as stuck', () => {
  const jobs = [
    job('Backend tests (1/3)', 'queued', ['latchkey-medium'], 400),
    job('Backend tests (2/3)', 'queued', ['latchkey-medium'], 100),
    job('Frontend tests', 'in_progress', ['latchkey-small'], 400),
    job(PROBE_JOB, 'queued', ['latchkey-small'], 900),
    job('Chart Lint', 'queued', ['ubuntu-latest'], 900),
  ];
  assert.deepEqual(stuckJobs(jobs, NOW, 300).map((j) => j.name), ['Backend tests (1/3)']);
});

// The loops run against a fake API and a fake clock that each wait advances.
const harness = async (envOverrides, jobsByPoll, artifactsByName = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'latchkey-route-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'x',
    GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    BUDGET_START: '2026-10-26T00:00:00Z', ...envOverrides,
  });
  let clock = NOW;
  let poll = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/jobs?')) {
      const jobs = jobsByPoll[Math.min(poll, jobsByPoll.length - 1)];
      poll += 1;
      if (jobs instanceof Error) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, json: async () => ({ jobs }) };
    }
    const name = new URL(path).searchParams.get('name');
    return { ok: true, json: async () => ({ artifacts: artifactsByName[name] || [] }) };
  };
  return {
    run: (fn) => fn({ now: () => clock, wait: async (ms) => { clock += ms; } }),
    out: async () => Object.fromEntries((await readFile(join(dir, 'out'), 'utf8')).trim().split('\n').map((l) => l.split('='))),
    restore: () => { globalThis.fetch = realFetch; process.env = saved; return rm(dir, { recursive: true, force: true }); },
  };
};

test('route sends heavy jobs to Latchkey once the probe is picked up', async () => {
  const h = await harness({}, [[job(PROBE_JOB, 'queued', ['latchkey-small'])], [job(PROBE_JOB, 'in_progress', ['latchkey-small'])]]);
  await h.run(route);
  assert.deepEqual(await h.out(), { use: 'true', backend: 'latchkey-medium', frontend: 'latchkey-small', service: 'latchkey-small', hold: 'false' });
  await h.restore();
});

test('route falls back and records a hold when the probe is never picked up', async () => {
  const h = await harness({ PICKUP_SEC: '60' }, [[job(PROBE_JOB, 'queued', ['latchkey-norunner'])]]);
  await h.run(route);
  assert.deepEqual(await h.out(), { use: 'false', backend: 'ubuntu-latest', frontend: 'ubuntu-latest', service: 'ubuntu-latest', hold: 'true' });
  await h.restore();
});

test('route falls back without probing when a hold is fresh or the budget is spent', async () => {
  let h = await harness({}, [[]], { 'latchkey-hold': [{ created_at: ago(120), expired: false }] });
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
  assert.equal((await h.out()).hold, 'false');
  await h.restore();
  h = await harness({ BUDGET_EQMIN: '0' }, [[job(PROBE_JOB, 'in_progress', ['latchkey-small'])]]);
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
  await h.restore();
});

test('route falls back on an API error and when the budget start is unset', async () => {
  let h = await harness({}, [new Error('502')]);
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
  await h.restore();
  h = await harness({ BUDGET_START: '' }, [[job(PROBE_JOB, 'in_progress', ['latchkey-small'])]]);
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
  await h.restore();
});

test('backstop trips on a held heavy job and passes once every heavy job starts', async () => {
  let h = await harness({ STUCK_SEC: '300' }, [[job('Backend tests (1/3)', 'queued', ['latchkey-medium'], 301)]]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'true');
  await h.restore();
  const running = [job('Backend tests (1/3)', 'in_progress', ['latchkey-medium']), job('Frontend tests', 'completed', ['latchkey-small'])];
  h = await harness({}, [[job('Backend tests (1/3)', 'queued', ['latchkey-medium'])], running, running]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'false');
  await h.restore();
});

test('backstop retries failed reads, and cancels only if the run stays unreadable', async () => {
  const running = [job('Backend tests (1/3)', 'in_progress', ['latchkey-medium'])];
  let h = await harness({}, [new Error('502'), running, running]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'false');
  await h.restore();
  h = await harness({ STUCK_SEC: '30' }, [new Error('502')]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'true');
  await h.restore();
});
