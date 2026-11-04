import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gate,
  PROBE_JOB, backstop, budgetDecision, budgetPeriod, heavyJobs, holdActive, probeState, route, runsSince, stuckJobs,
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

const DAY = 24 * 3600 * 1000;
const NOV = 30 * DAY;

test('the budget counts runs since the start and stops at 80% of the free minutes', () => {
  const start = '2026-10-26T00:00:00Z';
  const artifacts = [{ created_at: '2026-10-25T23:59:00Z' }, { created_at: '2026-10-26T00:00:00Z' }, { created_at: ago(10) }];
  assert.equal(runsSince(artifacts, start), 2);
  // At the end of the period the paced line is the whole 80%.
  const full = { elapsedMs: NOV, periodMs: NOV };
  assert.deepEqual(budgetDecision({ runs: 249, eqPerRun: 32, budgetEqMin: 10000, ...full }), { used: 7968, limit: 8000, allowed: 8000, ok: true });
  assert.equal(budgetDecision({ runs: 250, eqPerRun: 32, budgetEqMin: 10000, ...full }).ok, false);
  // A zero budget is the rehearsal for spent minutes, even on the first run.
  assert.equal(budgetDecision({ runs: 0, eqPerRun: 32, budgetEqMin: 0, ...full }).ok, false);
  assert.equal(budgetDecision({ runs: 0, eqPerRun: 32, budgetEqMin: 0, elapsedMs: 0, periodMs: NOV }).ok, false);
});

test('the budget is paced across the month: the first run goes, an early burst does not', () => {
  const at = (elapsedMs, runs) => budgetDecision({ runs, eqPerRun: 13, budgetEqMin: 4000, elapsedMs, periodMs: NOV });
  // One hour in, the paced line (3200 x 1/720, about 4) is below one run, so
  // the floor allows exactly one run's worth.
  assert.equal(at(3600 * 1000, 0).ok, true);
  assert.equal(at(3600 * 1000, 0).allowed, 13);
  assert.equal(at(3600 * 1000, 1).ok, false);
  assert.equal(at(0, 0).ok, true);
  assert.equal(at(2 * DAY, 30).ok, false);
  // Half way: 1600 allowed. 123 runs (1599) go, 124 (1612) do not.
  assert.equal(at(15 * DAY, 123).ok, true);
  assert.equal(at(15 * DAY, 124).ok, false);
  // The line caps at 1x: past the period end it stays at the full 3200.
  assert.equal(at(45 * DAY, 0).allowed, 3200);
  assert.equal(at(45 * DAY, 246).ok, true);
  assert.equal(at(45 * DAY, 247).ok, false);
  // A clock before the start is treated as the start, not as negative usage.
  assert.equal(at(-DAY, 0).allowed, 13);
});

test('the budget period is the later of LATCHKEY_BUDGET_START and the UTC month start', () => {
  // A start before this month: the month start wins, and the period is November.
  assert.deepEqual(budgetPeriod(Date.parse('2026-11-04T12:00:00Z'), '2026-10-26T00:00:00Z'),
    { start: '2026-11-01T00:00:00.000Z', periodMs: NOV });
  // A start inside this month: the start wins; the period is still the month's length.
  assert.deepEqual(budgetPeriod(Date.parse('2026-11-20T00:00:00Z'), '2026-11-15T00:00:00Z'),
    { start: '2026-11-15T00:00:00.000Z', periodMs: NOV });
  // Rollover: half an hour into December, the budget resets with no variable bump.
  assert.deepEqual(budgetPeriod(Date.parse('2026-12-01T00:30:00Z'), '2026-11-15T00:00:00Z'),
    { start: '2026-12-01T00:00:00.000Z', periodMs: 31 * DAY });
  assert.equal(budgetPeriod(Date.parse('2027-02-10T00:00:00Z'), '2026-11-15T00:00:00Z').periodMs, 28 * DAY);
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

test('with only backend shard 1 on Latchkey, it is the one heavy job and the one that can be stuck', () => {
  const jobs = [
    job('Backend tests (1/3)', 'queued', ['latchkey-medium'], 400),
    job('Backend tests (2/3)', 'queued', ['ubuntu-latest'], 400),
    job('Backend tests (3/3)', 'queued', ['ubuntu-latest'], 400),
    job('Frontend tests', 'queued', ['ubuntu-latest'], 400),
    job('Service Tests (Tier 1 — real DBs) (1/2)', 'queued', ['ubuntu-latest'], 400),
    job(PROBE_JOB, 'completed', ['latchkey-small'], 900),
  ];
  assert.deepEqual(heavyJobs(jobs).map((j) => j.name), ['Backend tests (1/3)']);
  assert.deepEqual(stuckJobs(jobs, NOW, 300).map((j) => j.name), ['Backend tests (1/3)']);
  jobs[0] = job('Backend tests (1/3)', 'in_progress', ['latchkey-medium'], 400);
  assert.deepEqual(stuckJobs(jobs, NOW, 300), []);
});

// The loops run against a fake API and a fake clock that each wait advances.
const harness = async (envOverrides, jobsByPoll, artifactsByName = {}, start = NOW) => {
  const dir = await mkdtemp(join(tmpdir(), 'latchkey-route-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'x',
    GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    BUDGET_START: '2026-10-26T00:00:00Z', ...envOverrides,
  });
  let clock = start;
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
    const params = new URL(path).searchParams;
    const page = Number(params.get('page') || 1);
    const rows = (artifactsByName[params.get('name')] || []).slice((page - 1) * 100, page * 100);
    return { ok: true, json: async () => ({ artifacts: rows }) };
  };
  return {
    run: (fn) => fn({ now: () => clock, wait: async (ms) => { clock += ms; } }),
    out: async () => Object.fromEntries((await readFile(join(dir, 'out'), 'utf8')).trim().split('\n').map((l) => l.split('='))),
    summary: () => readFile(join(dir, 'summary'), 'utf8'),
    restore: () => { globalThis.fetch = realFetch; process.env = saved; return rm(dir, { recursive: true, force: true }); },
  };
};

test('route sends heavy jobs to Latchkey once the probe is picked up', async () => {
  const h = await harness({}, [[job(PROBE_JOB, 'queued', ['latchkey-small'])], [job(PROBE_JOB, 'in_progress', ['latchkey-small'])]]);
  await h.run(route);
  assert.deepEqual(await h.out(), { use: 'true', backend: 'latchkey-medium', frontend: 'ubuntu-latest', service: 'ubuntu-latest', hold: 'false' });
  await h.restore();
});

test('only the backend label is routed, whatever the light label says', async () => {
  const h = await harness({ LIGHT_LABEL: 'latchkey-small', BACKEND_LABEL: 'latchkey-medium' }, [[job(PROBE_JOB, 'in_progress', ['latchkey-small'])]]);
  await h.run(route);
  const out = await h.out();
  assert.equal(out.backend, 'latchkey-medium');
  assert.equal(out.frontend, 'ubuntu-latest');
  assert.equal(out.service, 'ubuntu-latest');
  await h.restore();
});

test('route paces the month and counts only this month\'s runs', async () => {
  // 2026-10-26 12:00 is 25.5 of October's 31 days in: 3200 x 25.5/31 is about
  // 2632 allowed, so 202 runs of 13 (2626) go and 203 (2639) do not.
  const runsAt = (n, iso) => Array.from({ length: n }, () => ({ created_at: iso }));
  const picked = [[job(PROBE_JOB, 'in_progress', ['latchkey-small'])]];
  const cfg = { BUDGET_START: '2026-09-01T00:00:00Z', BUDGET_EQMIN: '4000', EQ_PER_RUN: '13' };
  let h = await harness(cfg, picked, { 'latchkey-run': runsAt(202, '2026-10-10T00:00:00Z') });
  await h.run(route);
  assert.equal((await h.out()).use, 'true');
  await h.restore();
  h = await harness(cfg, picked, { 'latchkey-run': runsAt(203, '2026-10-10T00:00:00Z') });
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
  assert.match(await h.summary(), /since 2026-10-01T00:00:00.000Z/);
  await h.restore();
  // September's runs do not count against October.
  h = await harness(cfg, picked, { 'latchkey-run': runsAt(203, '2026-09-20T00:00:00Z') });
  await h.run(route);
  assert.equal((await h.out()).use, 'true');
  await h.restore();
  // The first hours of a month allow one run, not a burst.
  const earlyOct = Date.parse('2026-10-01T02:00:00Z');
  h = await harness(cfg, picked, { 'latchkey-run': runsAt(1, '2026-10-01T01:00:00Z') }, earlyOct);
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
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

// The probe itself lands on a Latchkey runner, so it runs only after a check on
// GitHub-hosted says the hold and budget allow a Latchkey run. Without the gate
// the probe ran on every heavy push (about 100 a day) and the budget never
// counted it (#3440 review).
test('gate says go only when no hold is fresh and the budget allows a run', async () => {
  let h = await harness({ BUDGET_EQMIN: '4000', EQ_PER_RUN: '13' }, [[]]);
  await h.run(gate);
  assert.deepEqual(await h.out(), { go: 'true' });
  await h.restore();
  h = await harness({}, [[]], { 'latchkey-hold': [{ created_at: ago(120), expired: false }] });
  await h.run(gate);
  assert.deepEqual(await h.out(), { go: 'false' });
  await h.restore();
  h = await harness({ BUDGET_EQMIN: '0' }, [[]]);
  await h.run(gate);
  assert.deepEqual(await h.out(), { go: 'false' });
  await h.restore();
  h = await harness({ BUDGET_START: '' }, [[]]);
  await h.run(gate);
  assert.deepEqual(await h.out(), { go: 'false' });
  await h.restore();
});

test('gate says no on an API error', async () => {
  const h = await harness({}, [[]]);
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await h.run(gate);
  assert.deepEqual(await h.out(), { go: 'false' });
  await h.restore();
});

test('a budget start later than now keeps everything on GitHub', async () => {
  const later = new Date(NOW + 86400000).toISOString();
  let h = await harness({ BUDGET_START: later }, [[]]);
  await h.run(gate);
  assert.deepEqual(await h.out(), { go: 'false' });
  await h.restore();
  h = await harness({ BUDGET_START: later }, [[job(PROBE_JOB, 'in_progress', ['latchkey-small'])]]);
  await h.run(route);
  assert.equal((await h.out()).use, 'false');
  await h.restore();
});

test('route falls back at once, recording no hold, when the gate kept the probe off', async () => {
  // A probe that is never picked up would make a waiting route record a hold.
  const h = await harness({ GATE_GO: 'false', PICKUP_SEC: '60' }, [[job(PROBE_JOB, 'queued', ['latchkey-small'])]]);
  await h.run(route);
  assert.deepEqual(await h.out(), { use: 'false', backend: 'ubuntu-latest', frontend: 'ubuntu-latest', service: 'ubuntu-latest', hold: 'false' });
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
  h = await harness({ EXPECTED_HEAVY: '2' }, [[job('Backend tests (1/3)', 'queued', ['latchkey-medium'])], running, running]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'false');
  await h.restore();
});

test('backstop retries failed reads, and cancels only if the run stays unreadable', async () => {
  const running = [job('Backend tests (1/3)', 'in_progress', ['latchkey-medium'])];
  let h = await harness({ EXPECTED_HEAVY: '1' }, [new Error('502'), running, running]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'false');
  await h.restore();
  h = await harness({ STUCK_SEC: '30' }, [new Error('502')]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'true');
  await h.restore();
});

test('backstop keeps watching until every expected heavy job is listed', async () => {
  // Two polls see only the first shard started; the second shard is listed
  // later and is still queued past the limit, so the backstop must trip.
  const first = [job('Backend tests (1/3)', 'in_progress', ['latchkey-medium'])];
  const later = [...first, job('Backend tests (2/3)', 'queued', ['latchkey-medium'], 301)];
  const h = await harness({ EXPECTED_HEAVY: '2', STUCK_SEC: '300' }, [first, first, first, later]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'true');
  await h.restore();
});

test('backstop by default expects one heavy job, backend shard 1', async () => {
  const running = [job('Backend tests (1/3)', 'in_progress', ['latchkey-medium']), job('Backend tests (2/3)', 'in_progress', ['ubuntu-latest'])];
  const h = await harness({}, [running, running]);
  await h.run(backstop);
  assert.equal((await h.out()).tripped, 'false');
  assert.match(await h.summary(), /All 1 heavy Latchkey jobs were picked up/);
  await h.restore();
});

// Workflow wiring: read the jobs straight out of tests.yml.
const yml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'tests.yml'), 'utf8');
const jobBlock = (id) => {
  const m = yml.match(new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`));
  assert.ok(m, `job ${id} not found in tests.yml`);
  return m[1];
};
const runsOn = (id) => {
  const m = jobBlock(id).match(/^    runs-on: (.+)$/m);
  assert.ok(m, `job ${id} has no runs-on`);
  return m[1].trim();
};

test('tests.yml sends only backend shard 1 to the routed label', () => {
  assert.equal(runsOn('backend-tests'), "${{ matrix.shard == 1 && needs.latchkey-route.outputs.backend || 'ubuntu-latest' }}");
  assert.match(jobBlock('backend-tests'), /shard: \[1, 2, 3\]/);
  const routed = yml.match(/needs\.latchkey-route\.outputs\.(backend|frontend|service)/g) || [];
  // The route job's own outputs block declares steps.route.outputs.*, so the
  // only consumer of a routed label is backend-tests' runs-on.
  assert.deepEqual(routed, ['needs.latchkey-route.outputs.backend']);
});

test('tests.yml keeps frontend and service tests on GitHub-hosted runners', () => {
  for (const id of ['frontend-tests', 'service-test']) {
    assert.equal(runsOn(id), 'ubuntu-latest', `${id} runs-on`);
  }
  // The backstop's expected count matches the one routed job.
  assert.match(jobBlock('latchkey-backstop'), /EXPECTED_HEAVY: '1'/);
});

test('tests.yml runs the probe only when the gate on GitHub-hosted says go', () => {
  assert.equal(runsOn('latchkey-gate'), 'ubuntu-latest');
  assert.match(jobBlock('latchkey-gate'), /node scripts\/latchkey-route\.mjs gate/);
  const probe = jobBlock('latchkey-probe');
  assert.match(probe, /needs: \[changes, latchkey-gate\]/);
  assert.match(probe, /needs\.latchkey-gate\.outputs\.go == 'true'/);
  const route = jobBlock('latchkey-route');
  assert.match(route, /needs: \[changes, latchkey-gate\]/);
  assert.match(route, /GATE_GO: \$\{\{ needs\.latchkey-gate\.outputs\.go \}\}/);
});
