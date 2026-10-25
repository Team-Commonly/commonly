# CI heavy jobs on Latchkey runners

The heavy jobs in `.github/workflows/tests.yml` (the three backend shards,
frontend tests and the two Tier 1 service shards) can run on Latchkey runners,
which don't count against the org's 20-concurrent-job cap on GitHub-hosted
runners. That cap is what made the merge queue wait (D37).

They do so only on **merge-queue runs**, and only while the repository
variable `LATCHKEY_HEAVY` is `on`. Every other run, PRs included, stays on
GitHub-hosted runners, which are free on this public repo. Backend runs on
`latchkey-medium` and frontend and service on `latchkey-small` (sizes below).

## How a run is routed

A held Latchkey job (free minutes spent, the spend limit reached, or an
outage) does not fail. It sits "queued" on GitHub with no error, and a
required check that waits on it leaves the merge queue stalled with nothing
red anywhere. So nothing is sent to Latchkey blind. The logic is
`scripts/latchkey-route.mjs`, with tests in
`scripts/__tests__/latchkey-route.test.mjs`.

1. **Latchkey probe** asks for a `latchkey-small` runner and only echoes. It
   is not in the gate's needs, so a held probe never holds the required check.
2. **Latchkey route** (GitHub-hosted) picks GitHub-hosted for the heavy jobs
   when:
   - a `latchkey-hold` artifact was recorded in the last 60 minutes;
   - the budget is spent, or `LATCHKEY_BUDGET_START` is unset; or
   - the probe isn't picked up within 180 s. This case also records a hold.

   Otherwise it sends the heavy jobs to Latchkey and records a `latchkey-run`
   artifact, which is the budget's counter. Any API error falls back to
   GitHub-hosted.
3. **Latchkey backstop** (GitHub-hosted) watches the heavy jobs once they are
   routed. If one is still queued after 300 s, it records a hold and cancels
   the run. The queue entry then fails loudly instead of waiting, and later
   runs stay on GitHub until the hold expires. The press re-queues the PR as
   for any dequeue.

The budget is an estimate: Latchkey runs since `LATCHKEY_BUDGET_START` times
`LATCHKEY_EQ_PER_RUN` (default 48 small-equivalent minutes, measured on the 10-25 rehearsal), stopped at 80%
of `LATCHKEY_BUDGET_EQMIN` (default 10000). The 20% left is margin for the
estimate and for runs already in flight. Check it against the measured
figure below, and raise `LATCHKEY_EQ_PER_RUN` if the measured figure is higher.

## Variables

| variable | meaning | default |
|---|---|---|
| `LATCHKEY_HEAVY` | `on` routes merge-queue runs through Latchkey; anything else is off | off |
| `LATCHKEY_BUDGET_START` | ISO start of the free-minute period; unset keeps everything on GitHub | none |
| `LATCHKEY_BUDGET_EQMIN` | free small-equivalent minutes in the period | 10000 |
| `LATCHKEY_EQ_PER_RUN` | estimated small-equivalent minutes per routed run | 48 |
| `LATCHKEY_PICKUP_SEC` | how long the route waits for the probe | 180 |
| `LATCHKEY_BACKEND_LABEL` / `LATCHKEY_LIGHT_LABEL` | runner sizes | `latchkey-medium` / `latchkey-small` |

## Turn it on, and off

```bash
gh variable set LATCHKEY_BUDGET_START --body 2026-10-26T00:00:00Z --repo Team-Commonly/commonly
gh variable set LATCHKEY_HEAVY --body on --repo Team-Commonly/commonly
# off: runs that start afterwards are entirely GitHub-hosted
gh variable delete LATCHKEY_HEAVY --repo Team-Commonly/commonly
```

Runs already routed keep their labels. If one is held, the backstop cancels it.

## Rehearse the fallback

Dispatch Tests with `latchkey: true`. This works whether or not
`LATCHKEY_HEAVY` is set, because dispatch is maintainer-only.

- **A held job:** set `latchkey_probe_label` to a label no runner serves. The
  route waits out the pickup time, records a hold and runs the heavy jobs on
  GitHub. Cancel the run afterwards, since the probe stays queued. Then delete
  the hold artifact, or wait an hour for it to expire.
- **Spent minutes:** set `latchkey_budget_eqmin` to `0`. The route falls back
  without waiting.
- **The real path:** no overrides. This spends about 30 small-equivalent
  minutes.

## Measure the burn

Latchkey bills per job, rounded up to the minute, at 1× for small and 2× for
medium. Sum `ceil(job minutes) × size` over the Latchkey-labelled jobs from
the Actions jobs API, per day. The figure matched Latchkey's own meter within
a few percent on the 10-24 trial. Compare it to the budget estimate above.

## Trust boundary

- Every `pull_request` run uses `ubuntu-latest`, fork or not. The routing
  jobs are skipped on PR runs.
- A `merge_group` run can use Latchkey, including a group that holds a
  reviewed fork change. The route does not inspect where queued PRs came
  from.
- So queue admission is the trust decision: a maintainer puts a PR in the
  queue only after its gate passed. A green test run, or this expression, does
  not establish that trust. GitHub doesn't enforce the seat review either; the
  ruleset requires only a green merge queue, so the review gate is operating
  process.
- That is acceptable here because the test jobs get only `contents: read`,
  the workflow has no `pull_request_target` trigger, and the jobs see test
  fixtures, not production secrets. Two routing jobs get more, and both run
  on GitHub-hosted runners: the route gets `actions: read`, to read the run's
  jobs and the hold and budget artifacts, and the backstop gets
  `actions: write`, to cancel its own run. A queued change can rewrite those
  jobs like any other part of the workflow, which is why queue admission, not
  this file, is the trust decision. Latchkey documents single-job VMs
  destroyed after each job (vendor-published, not independently attested).

## Why these sizes, and the Mongo ulimit

Measured 2026-10-24 on dispatch-only trial runs:

- **latchkey-small:** backend shards took 6.0, 12.7 and 16.6 minutes, against
  2.5 to 2.9 on GitHub. Slower overall, and more weighted minutes per run than
  medium (about 40 against about 26).
- **latchkey-medium:** backend shards took about 3 minutes.
- **Mongo on Latchkey:** the `mongo:7` service container died with EMFILE ("Too
  many open files") during index builds, then WT_PANIC, because the runner's
  docker default `nofile` is low. `--ulimit nofile=64000:64000` on the service
  fixes it; with it, the service tests passed 670 of 670 in 5.5 minutes. The
  limit applies on GitHub-hosted runners too (it is not gated on the
  variable); the service tests passed there with it on this PR's CI.

tool-tests stays on GitHub: its CLI PATH test fails on Latchkey, and its Jest
process doesn't exit.

Frontend took 2.8 minutes on small against 1.9 on medium, and the service
tests 5.5 minutes on small, unsharded. Medium counts double against the free
minutes and is rounded up per job, so a bigger size pays off only when it at
least halves a job's time: it does for the backend shards (about 18
small-equivalent minutes a run on medium against 36 on small) and does not for
frontend or service. Each figure is one trial run, so re-measure before
changing sizes.
