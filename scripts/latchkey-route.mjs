#!/usr/bin/env node
// Routes the Tests workflow's heavy jobs to Latchkey runners, with a fallback
// to GitHub-hosted runners that never leaves the merge queue waiting on a
// held job. See docs/runbooks/ci-heavy-runner.md.
//
//   route     run by the "Latchkey route" job. Picks GitHub-hosted when a
//             hold is fresh or the budget is spent, otherwise waits for the
//             "Latchkey probe" job to be picked up. A probe still queued after
//             PICKUP_SEC means Latchkey is holding jobs: the heavy jobs go to
//             GitHub-hosted and the job records a hold for later runs.
//   backstop  run by the "Latchkey backstop" job once the heavy jobs are
//             routed. A heavy job still queued after STUCK_SEC trips it: the
//             job records a hold and cancels the run, so a held job fails the
//             required check instead of leaving it pending.
//
// Any API error routes to GitHub-hosted. Falling back is never a failure.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROBE_JOB = 'Latchkey probe';
export const HOLD_ARTIFACT = 'latchkey-hold';
export const RUN_ARTIFACT = 'latchkey-run';
export const BUDGET_FRACTION = 0.8;
const GITHUB_LABEL = 'ubuntu-latest';

const isLatchkey = (job) => (job.labels || []).some((label) => label.startsWith('latchkey-'));
const started = (job) => job.status === 'in_progress' || job.status === 'completed';
const ageSec = (iso, now) => (now - Date.parse(iso)) / 1000;

// A hold is fresh for holdMin minutes after it was recorded.
export const holdActive = (artifacts, now, holdMin) => artifacts.some((a) => !a.expired
  && ageSec(a.created_at, now) < holdMin * 60);

// Latchkey runs recorded since the budget period started.
export const runsSince = (artifacts, startIso) => artifacts
  .filter((a) => Date.parse(a.created_at) >= Date.parse(startIso)).length;

// The guard stops at BUDGET_FRACTION of the free minutes, leaving the rest as
// margin for the estimate and for runs already in flight.
export const budgetDecision = ({ runs, eqPerRun, budgetEqMin }) => {
  const used = runs * eqPerRun;
  const limit = budgetEqMin * BUDGET_FRACTION;
  return { used, limit, ok: used < limit };
};

// Heavy Latchkey jobs (every Latchkey-labelled job except the probe) still
// queued after stuckSec.
export const stuckJobs = (jobs, now, stuckSec) => jobs
  .filter((job) => isLatchkey(job) && job.name !== PROBE_JOB && !started(job)
    && ageSec(job.created_at, now) > stuckSec);

export const heavyJobs = (jobs) => jobs.filter((job) => isLatchkey(job) && job.name !== PROBE_JOB);

export const probeState = (jobs) => {
  const probe = jobs.find((job) => job.name === PROBE_JOB);
  if (!probe) return 'missing';
  return started(probe) ? 'started' : 'queued';
};

const env = (name, fallback) => {
  const value = (process.env[name] || '').trim();
  return value || fallback;
};

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'commonly-latchkey-route',
    },
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
};

const listArtifacts = async (name, startIso) => {
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const body = await api(`actions/artifacts?name=${name}&per_page=100&page=${page}`);
    const rows = body.artifacts || [];
    out.push(...rows);
    // Newest first, so a page with nothing inside the window ends the scan.
    if (rows.length < 100 || (startIso && !rows.some((a) => Date.parse(a.created_at) >= Date.parse(startIso)))) break;
  }
  return out;
};

const runJobs = async () => {
  const body = await api(`actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT || 1}/jobs?per_page=100`);
  return body.jobs || [];
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const output = (values) => {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
};

const summary = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
};

const labels = (use) => ({
  use,
  backend: use ? env('BACKEND_LABEL', 'latchkey-medium') : GITHUB_LABEL,
  frontend: use ? env('LIGHT_LABEL', 'latchkey-small') : GITHUB_LABEL,
  service: use ? env('LIGHT_LABEL', 'latchkey-small') : GITHUB_LABEL,
});

export const route = async ({ now = () => Date.now(), wait = sleep } = {}) => {
  const fallback = (reason, hold = false) => {
    summary(`Heavy jobs on GitHub-hosted runners: ${reason}.`);
    output({ ...labels(false), hold });
  };
  try {
    const holds = await listArtifacts(HOLD_ARTIFACT);
    const holdMin = Number(env('HOLD_MIN', '60'));
    if (holdActive(holds, now(), holdMin)) return fallback(`a Latchkey hold was recorded in the last ${holdMin} min`);

    const start = env('BUDGET_START', '');
    if (!start || Number.isNaN(Date.parse(start))) return fallback('LATCHKEY_BUDGET_START is not set');
    const runs = runsSince(await listArtifacts(RUN_ARTIFACT, start), start);
    const budget = budgetDecision({
      runs,
      eqPerRun: Number(env('EQ_PER_RUN', '48')),
      budgetEqMin: Number(env('BUDGET_EQMIN', '10000')),
    });
    summary(`Latchkey budget since ${start}: ${runs} runs, about ${budget.used} of ${budget.limit} small-equivalent minutes allowed.`);
    if (!budget.ok) return fallback('the Latchkey budget is spent');

    const pickupSec = Number(env('PICKUP_SEC', '180'));
    const deadline = now() + pickupSec * 1000;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const state = probeState(await runJobs());
      if (state === 'started') {
        summary('Heavy jobs on Latchkey runners: the probe was picked up.');
        return output({ ...labels(true), hold: false });
      }
      if (now() >= deadline) {
        return fallback(`the Latchkey probe was not picked up within ${pickupSec} s (probe ${state})`, true);
      }
      // eslint-disable-next-line no-await-in-loop
      await wait(10000);
    }
  } catch (error) {
    return fallback(`routing failed (${error.message})`);
  }
};

export const backstop = async ({ now = () => Date.now(), wait = sleep } = {}) => {
  const stuckSec = Number(env('STUCK_SEC', '300'));
  // Matrix jobs are listed as they expand, so a poll can see only some of
  // them. The backstop passes only once this many heavy jobs have started.
  const expected = Number(env('EXPECTED_HEAVY', '6'));
  // Long enough for the heavy jobs to be queued and for any of them to pass
  // stuckSec; past it there is nothing left to watch.
  const deadline = now() + (stuckSec + 300) * 1000;
  let stable = 0;
  let lastError = null;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const jobs = await runJobs();
      lastError = null;
      const stuck = stuckJobs(jobs, now(), stuckSec);
      if (stuck.length) {
        summary(`Latchkey is holding ${stuck.map((job) => job.name).join(', ')}: recording a hold and cancelling the run.`);
        return output({ tripped: true });
      }
      const heavy = heavyJobs(jobs);
      // Two polls in a row with every expected heavy job listed and started,
      // so a matrix still being expanded is not mistaken for a finished pickup.
      stable = heavy.length >= expected && heavy.every(started) ? stable + 1 : 0;
      if (stable >= 2) {
        summary(`All ${heavy.length} heavy Latchkey jobs were picked up.`);
        return output({ tripped: false });
      }
    } catch (error) {
      // A failed read is retried until the deadline.
      lastError = error;
      stable = 0;
    }
    if (now() >= deadline) {
      // Unreadable to the end: cancel rather than risk a held job leaving the
      // required check pending.
      if (lastError) {
        summary(`Backstop could not read the run (${lastError.message}): recording a hold and cancelling the run.`);
        return output({ tripped: true });
      }
      summary('No heavy Latchkey job left to watch.');
      return output({ tripped: false });
    }
    // eslint-disable-next-line no-await-in-loop
    await wait(15000);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const mode = process.argv[2];
  if (mode === 'route') await route();
  else if (mode === 'backstop') await backstop();
  else {
    console.error('usage: latchkey-route.mjs route|backstop');
    process.exit(2);
  }
}
