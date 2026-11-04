# CI heavy jobs on Latchkey runners

One heavy job in `.github/workflows/tests.yml`, **`Backend tests (1/3)`**, can
run on a Latchkey runner (`latchkey-medium`). Latchkey runners don't count
against the org's 20-concurrent-job cap on GitHub-hosted runners, which is what
made the merge queue wait. Backend shards 2 and 3, frontend tests and both Tier 1
service shards always run on GitHub-hosted runners.

Shard 1 is routed only on a **push to `main`** that touched a heavy path (the
`changes` path filter in the workflow), and only while the repository variable
`LATCHKEY_HEAVY` is `on`. Every other run — PRs, and the `merge_group` required
check — stays on GitHub-hosted runners, which are free on this public repo, so a
docs-only merge spends no Latchkey minutes.

## Why one job

Minutes. Routing every heavy job (three backend shards on medium, frontend and
two service shards on small) cost an estimated 48 small-equivalent minutes per
run. At about 100 heavy pushes to `main` a day, that spent the whole free
allowance (22,452 minutes) in under a month, and `LATCHKEY_HEAVY` was turned
off until the monthly reset. One representative job keeps the routing, the
probe and the backstop exercised on every routed run at about a quarter of the
cost: shard 1 takes about 4 minutes on medium, which bills at about 12 small-
equivalent minutes, plus about one for the probe, so about 13 per run.

History: before 2026-11-01 this routed on `merge_group`; it moved to push:main
plus the path filter because the queue ran Latchkey on every entry. Until
F138 (2026-11) every heavy job was routed.

## How a run is routed

A held Latchkey job (free minutes spent, the spend limit reached, or an
outage) does not fail. It sits "queued" on GitHub with no error. Latchkey runs
only on the post-merge push to `main`, so a held job doesn't stall a required
check (the merge queue runs its heavy jobs on GitHub-hosted runners); the
backstop below still cancels the held post-merge run so it does not hang.
Nothing is sent to Latchkey blind. The logic is `scripts/latchkey-route.mjs`,
with tests in `scripts/__tests__/latchkey-route.test.mjs`.

1. **Latchkey probe** asks for a `latchkey-small` runner and only echoes. It
   is not in the gate's needs, so a held probe never holds the required check.
2. **Latchkey route** (GitHub-hosted) picks GitHub-hosted for shard 1 when:
   - a `latchkey-hold` artifact was recorded in the last 60 minutes;
   - the paced budget is spent for this point in the month, or
     `LATCHKEY_BUDGET_START` is unset; or
   - the probe isn't picked up within 180 s. This case also records a hold.

   Otherwise it outputs the Latchkey backend label and records a
   `latchkey-run` artifact, which is the budget's counter. Any API error falls
   back to GitHub-hosted. Its `frontend` and `service` outputs are always
   `ubuntu-latest`. The backend job's runner is
   `${{ matrix.shard == 1 && needs.latchkey-route.outputs.backend || 'ubuntu-latest' }}`:
   shards 2 and 3 get `ubuntu-latest`, and so does shard 1 when the route is
   skipped (empty output) or falls back.
3. **Latchkey backstop** (GitHub-hosted) watches shard 1 once it is routed
   (`EXPECTED_HEAVY: '1'`). If it is still queued after 300 s, it records a
   hold and cancels
   the (post-merge) run instead of letting it hang, and later push-to-main runs
   stay on GitHub until the hold expires. Since this is post-merge there is no
   queue entry to re-run; the change is already on `main`, and the `merge_group`
   check that gated it ran on GitHub-hosted runners.

## The paced monthly budget

The budget is an estimate: Latchkey runs in the current period times
`LATCHKEY_EQ_PER_RUN`, against 80% of `LATCHKEY_BUDGET_EQMIN`. The 20% left is
margin for the estimate and for runs already in flight.

- **The period** is the current calendar month in UTC, but never earlier than
  `LATCHKEY_BUDGET_START`: runs are counted from the later of the two. The
  budget resets on the 1st of each month with no variable bump.
- **It is paced.** At any moment the allowed usage is
  `limit × min(1, elapsed / month length)`, where `limit` is 80% of
  `LATCHKEY_BUDGET_EQMIN`, `elapsed` runs from the period start and the month
  length is the real length of the current month. The line never drops below
  one run's worth (`LATCHKEY_EQ_PER_RUN`), so the first run of a month goes,
  and never rises above `limit`. A run is routed while `used < allowed`.
  Without pacing, the 10-26 to 11-01 burn spent a month's minutes in days.
- A `LATCHKEY_BUDGET_START` in the middle of a month paces conservatively:
  elapsed is counted from that start but divided by the whole month, so that
  month allows less than the full 80%.

Check the estimate against the measured figure below, and raise
`LATCHKEY_EQ_PER_RUN` if the measured figure is higher.

## Variables

| variable | meaning | default |
|---|---|---|
| `LATCHKEY_HEAVY` | `on` routes push-to-`main` runs that touched a heavy path through Latchkey; anything else is off | off |
| `LATCHKEY_BUDGET_START` | ISO time before which no run counts; the period is the later of this and the UTC month start; unset keeps everything on GitHub | none |
| `LATCHKEY_BUDGET_EQMIN` | small-equivalent minutes the routing may spend per month | 10000 |
| `LATCHKEY_EQ_PER_RUN` | estimated small-equivalent minutes per routed run | 48 |
| `LATCHKEY_PICKUP_SEC` | how long the route waits for the probe | 180 |
| `LATCHKEY_BACKEND_LABEL` | runner size for backend shard 1 | `latchkey-medium` |
| `LATCHKEY_LIGHT_LABEL` | runner size for the probe only | `latchkey-small` |

The script defaults (10000 and 48) predate the one-job routing. Set the
variables explicitly at the re-enable, below.

## Turn it on, and off

`LATCHKEY_HEAVY` is off until the free allowance resets (around 2026-12-01).
After the reset, set the budget for one job and turn it back on:

```bash
gh variable set LATCHKEY_BUDGET_EQMIN --body 4000 --repo Team-Commonly/commonly
gh variable set LATCHKEY_EQ_PER_RUN --body 13 --repo Team-Commonly/commonly
gh variable set LATCHKEY_HEAVY --body on --repo Team-Commonly/commonly
# off: runs that start afterwards are entirely GitHub-hosted
gh variable delete LATCHKEY_HEAVY --repo Team-Commonly/commonly
```

`LATCHKEY_BUDGET_START` can stay at its old value: the period never starts
before the current month. Set it to a later time only to discard runs already
counted this month.

Sizing: 4000 × 0.8 / 13 ≈ 246 routed runs a month, paced to about 8 a day. At
about 100 heavy pushes a day, most pushes run shard 1 on GitHub-hosted; the
route's summary says which, and why.

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
- **The real path:** no overrides. This spends about 13 small-equivalent
  minutes (shard 1 on medium and the probe).

## Measure the burn

Latchkey bills per job, rounded up to the minute, at 1× for small and 2× for
medium. Sum `ceil(job minutes) × size` over the Latchkey-labelled jobs from
the Actions jobs API, per day. The figure matched Latchkey's own meter within
a few percent on the 10-24 trial. Compare it to the budget estimate above.

The 2× rate is from that trial. The per-run figure later used for billing (48
small-equivalent minutes for about 15 small and 10 medium job-minutes) implies
a medium minute counts as about 3 small, and the one-job sizing (13 per run)
assumes 3×. Re-measure shard 1 against Latchkey's meter after the re-enable and
correct `LATCHKEY_EQ_PER_RUN` to match.

## Trust boundary

- Every `pull_request` run uses `ubuntu-latest`, fork or not. The routing
  jobs are skipped on PR runs.
- `merge_group` runs also use `ubuntu-latest` — the routing jobs are skipped
  there too, so the required check never touches Latchkey.
- Latchkey runs only on a push to `main`, i.e. after a change has already
  merged. So only code that cleared review and the merge queue ever reaches the
  privileged runners — a stricter boundary than the old `merge_group` routing,
  where the group held PRs that had passed their gate but not yet merged. The
  merge is the trust decision; a green test run, or this expression, does not
  establish it.
- That is acceptable here because the test jobs get only `contents: read`,
  the workflow has no `pull_request_target` trigger, and the jobs see test
  fixtures, not production secrets. Two routing jobs get more, and both run
  on GitHub-hosted runners: the route gets `actions: read`, to read the run's
  jobs and the hold and budget artifacts, and the backstop gets
  `actions: write`, to cancel its own run. A queued change can rewrite those
  jobs like any other part of the workflow, which is why the merge to `main`,
  not this file, is the trust decision. Latchkey documents single-job VMs
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
