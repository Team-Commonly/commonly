# Reading GitHub Actions state for a pull request

Use the run, job, check-suite, and PR-rollup APIs together. Each view is a
different projection; none is a complete source of truth by itself.

## First pass

```bash
gh pr checks <number>
gh pr view <number> --json headRefName,headRefOid,statusCheckRollup
gh run list --branch <branch> --limit 30
```

`gh pr checks` is a convenient summary and may collapse checks with the same
name. The PR `statusCheckRollup` can include stale or superseded generations.
Map a suspicious row to its run and inspect the jobs:

```bash
gh run view <run-id> --json status,conclusion,headSha,event,jobs
gh api repos/Team-Commonly/commonly/actions/runs/<run-id>/jobs?filter=all \
  --jq '.jobs[] | [.run_attempt,.name,.status,.conclusion] | @tsv'
```

## Interpret the states

- `completed/success`: terminal and green for that generation.
- `completed/failure` with jobs that never started: a dispatch/startup failure,
  not evidence that tests ran and failed.
- `queued` with no newer successor: wait briefly and re-check the run and jobs.
- `queued` after a newer same-workflow run completed: stale; read the newer run.
- `cancelled`: normally superseded by concurrency or an explicit cancellation;
  inspect the successor before rerunning.
- A job that remains queued after its run is terminal is an orphaned job. A new
  commit is the reliable way to clear SHA-scoped rollup state.

Do not infer a rerun from `run_attempt` alone. Use the jobs endpoint with
`filter=all` and compare attempts, timestamps, and conclusions.

## Check suites and missing fan-out

When a workflow appears absent, query suites for the PR head SHA:

```bash
gh api repos/Team-Commonly/commonly/commits/<sha>/check-suites?per_page=100 \
  --jq '.check_suites[] | [.app.slug,.status,.conclusion] | @tsv'
```

An existing GitHub Actions suite proves dispatch. An absent suite is only useful
after the normal fan-out window has elapsed; delayed allocation happens. Query
by SHA for PR workflows because app-driven runs may not appear under the branch
name you expect.

## Choosing a recovery action

1. If the workflow never dispatched, use the repository's normal PR trigger
   recovery (usually a close/reopen or a new commit) only after confirming no
   other trigger is in flight.
2. If the run started and failed, fix the failure or rerun that run when the
   failure is transient.
3. If the run is terminal but jobs are orphaned, move the head to a new SHA;
   repeated reruns add another generation and do not repair the old rollup.
4. If a check is genuinely queued, wait rather than adding more queued runs.

Record the run ID, head SHA, workflow, event, and the job-level evidence in the
PR discussion. Avoid pasting secrets or full logs when a short excerpt is
enough.
