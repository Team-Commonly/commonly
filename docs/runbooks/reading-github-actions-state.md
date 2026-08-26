# Reading GitHub Actions state for a PR

Three seats spent most of 2026-08-26 diagnosing "the checks on my PR are
missing" and reached four mutually contradictory conclusions, all from correct
commands. Every contradiction came from the same place: **the run object and
the PR's check list are summaries, and each one is lossy in a different
direction.** This runbook names which reader answers which question.

## An absent or short check list has at least five causes

They render identically on the PR page — a row that is missing, or grey. They
are not the same problem and they do not share a remedy.

| Cause | How it looks | Discriminator | Remedy |
|---|---|---|---|
| Run never created | check absent from `gh pr checks` | no run at that SHA in `gh run list --branch <b>` | needs a NEW event: push, or close/reopen |
| `startup_failure` | check absent from `gh pr checks` | run exists, `conclusion=startup_failure`, 0 jobs | close/reopen |
| Queued, pool saturated | grey/pending | run exists, `status=queued`, age climbing, **and no completed successor** | wait — re-triggering adds to the back of the line |
| Superseded by concurrency | run `cancelled` | a NEWER run exists at a newer SHA in the same group | none needed; read the newer run |
| Superseded but never cancelled | grey/pending, indefinitely | run `status=queued` **and** a later run of the same workflow on the same branch has `completed` | none — it is dead; read the successor |
| Jobs cancelled at 0 steps | run `failure` | jobs `cancelled`, `steps=0`, and no newer run to have superseded them | `gh run rerun <id>` |
| Orphaned jobs | check shows **`pending`, forever** | run `completed/failure`, jobs still `queued/null` at `steps=0` | `gh run rerun <id>` — waiting never resolves it |

Two of these mislead in opposite directions. A run-level `failure` reads as
"the tests failed" when nothing ever executed. And a check row reporting
`pending` can belong to a run that terminated over an hour ago: the row
inherits its **job's** status, and a job orphaned by a terminating run stays
`queued/null` permanently. `gh pr checks` will show it as pending until the
head moves.

## A queued run is not evidence of a queue

`status=queued` is the one state this document tells you to wait on, so it is
worth knowing that most queued runs on this repo are not waiting for anything.

Measured 2026-08-26: `?status=queued` returned `total_count: 11` repo-wide, and
**all eleven had a later run of the same workflow on the same branch already
completed.** Live queue depth was zero. Ten sat across four PR branches; the
eleventh was `Uptime Check` on `main`, queued since 2026-08-19 with 23 completed
runs after it — seven days, on a cron workflow, invisible from any PR page and
untouchable by a PR-level remedy.

These are *not* the same thing as the orphaned **jobs** in the table above. That
state is a terminated run whose jobs never left `queued`; this one is a whole
run that never started and never got cancelled either, despite the concurrency
group that should have swept it. Two different leaks, and "orphaned" gets used
for both — say which layer you mean.

The check is one call, and it is the difference between "the pool is backed up,
wait" and "this run is dead, read the successor":

```bash
gh api "repos/<o>/<r>/actions/runs?branch=<branch>&per_page=100" \
  --jq '[.workflow_runs[] | select(.name=="<workflow>" and .created_at > "<queued_run_created_at>" and .status=="completed")] | length'
```

Non-zero means the queued run you are watching has already been outlived. A
repo-wide queue-depth number that has not been through this filter measures
accumulated debris, not load.

**So the discriminator is the run's `status`, not the check's.** Map check →
`check_suite` → run, and only `status: in_progress` or `queued` earns waiting.
Both states were live on this repo simultaneously on 2026-08-26: PR #1216's
three guard runs were genuinely `queued` 78 minutes after creation, while PR
#1277's five pending rows all belonged to runs that had already concluded
`failure` — one at 15:22, two more three seconds after they were created.

Job count and step count then tell you *what* went wrong; they cannot tell you
whether it is still going.

## Three fields that do not mean what their names promise

**`run_attempt` cannot detect whether a rerun happened.** Measured on four runs
rerun within the same minute: `32985824262`, `32985824328` and `32985899276`
each went `completed/failure` → `queued/null` with `run_attempt` still `1` and
`previous_attempt_url` unset. `32985813845` went to `run_attempt=2`. An audit
that filters on `run_attempt > 1` will conclude no rerun ever happened, on a
repo where reruns are landing.

**`/runs/:id/jobs` returns only the latest attempt, and returns nothing while
that attempt is queued.** On run `32985813845` it reported `total_count: 0`
minutes after attempt 2 had finished successfully. Zero jobs is therefore
ambiguous between *never started* and *re-queued, jobs not yet created* — and
the first is exactly what a `startup_failure` looks like. Use
`/runs/:id/jobs?filter=all`, which lists every attempt with its own
`run_attempt`, conclusion and step count:

```bash
gh api "repos/<owner>/<repo>/actions/runs/<id>/jobs?filter=all" \
  -q '.jobs[] | "\(.run_attempt): \(.name) \(.status)/\(.conclusion) steps=\(.steps|length)"'
# 1: Source changed ⇒ version bumped completed/cancelled steps=0
# 2: Source changed ⇒ version bumped completed/success  steps=5
```

**The run object lags its own jobs.** At the moment the listing above was
captured, `gh api repos/<o>/<r>/actions/runs/32985813845` still reported
`status=queued conclusion=null`. The job records were already terminal.

**And it leads them, too — so neither field is authoritative on its own.** Run
`32985816249` (#1271's CodeQL, `event: dynamic`) reads `completed/failure` while
all three of its jobs are still `queued`, `conclusion: null`, `completed_at:
null`, hours after `started_at`. `gh pr checks` renders those as `pending` with
duration `0`, which is indistinguishable from a job that is genuinely about to
run. The sibling run `32984068926` on #1216 has the same shape one step later —
jobs `completed/cancelled` after 15m4s — and `gh pr checks` renders *those* as
`fail`. So a `pending` row can belong to a run that has already failed, and a
`fail` row can be a cancellation rather than a test failure. Read the run
conclusion and the per-attempt job listing together; when they disagree, the
disagreement is the finding.

## Check-suites separate never-dispatched from dispatched-and-stuck

This is the sharpest instrument in this document, and it answers the question
the run list cannot: was the workflow ever dispatched at all? Every dispatched
workflow allocates a `github-actions` check-suite *whether or not its run ever
starts*, so a suite that exists proves dispatch. **An absent suite proves
nothing until you have waited — see the timeout below.** So:

```bash
gh api "repos/<o>/<r>/commits/<sha>/check-suites?per_page=50" \
  -q '.check_suites[] | "\(.created_at) app=\(.app.slug) \(.status)/\(.conclusion) runs=\(.latest_check_runs_count)"'
```

Measured at PR #1216's head on 2026-08-26: three `github-actions` suites created
15:08:11, 15:08:13 and 15:09:50, all `queued`, one per stuck guard workflow —
and **no suite at all** for `Tests` or `Playwright Tests`. Those two were never
dispatched. At PR #1277's head, two suites sit at `completed/startup_failure`
with zero runs, which is the terminal state-1 case wearing the same face.

**The absence of a suite is only evidence after ~25 minutes, and reading it
sooner is the mistake this instrument invites.** Allocation is usually fast and
occasionally is not; measured on one PR, one lever, on the same afternoon:
`+9s`, `+13m16s`, `+21m18s`. A reading taken at +20 minutes and called
never-dispatched was contradicted 94 seconds later by five green runs. A second
reading, taken 7 minutes after a push that had produced only CodeQL, called it
never-created; the other five workflows arrived at +8 minutes untouched. The
instrument is sound — a suite that exists really does prove dispatch — but the
*absence* of one is a claim about the future, so give it the same ~25 minutes
the fan-out section asks for before acting on it.

**Do not key on `latest_check_runs_count`.** A dispatched-but-queued suite
reports `runs: 0`, identical to an empty one. The suite's *existence at that
sha* is the signal; its count is not.

One collection caveat that cost time here: CodeQL and other app-driven runs are
recorded against `refs/pull/<n>/head`, not the branch, so
`?branch=<branch-name>` can return zero for a PR that visibly has runs. Query
by `head_sha` or via the commit's check-suites instead.

## A re-trigger may fan out partially, and stragglers arrive minutes later

Close/reopen re-fires `pull_request` workflows without moving the head, which is
what makes it the right lever over an empty commit when a run was never created.
It does work. But it does **not reliably** deliver the whole fan-out at once —
sometimes it does and sometimes it does not — so an early check tells you almost
nothing either way.

Measured on 2026-08-26. PR #1277 reopened at 15:44:40Z: `Secret Scan` and
`Tests` were created 9 seconds later, and three more workflows —
`Package Version Guard`, `Playwright Tests`, `PR Base Freshness` — only at
15:57:56Z, 13 minutes on. Same trigger, same PR, one fan-out split across
thirteen minutes. PR #1275 had two reopens (15:57:30Z, 16:11:42Z) and two run
batches (16:19:58Z, 16:30:30Z); depending on how you pair them the delay is
either 8 and 19 minutes or 22 and 19.

**That pairing is the trap.** Nothing in the run object names the event that
created it, so with more than one trigger in flight the delay is not a quantity
you can measure — two of us independently derived confident and incompatible
numbers from the same four timestamps. What the data supports is a bound and a
shape: **some runs land in seconds, some take up to ~20 minutes, and a partial
batch is the normal intermediate state, not evidence of a failure.**

**Two pairings are determined, and they give 10 minutes and 11 seconds.** PR #1216 was
close/reopened at 16:36:37Z with no other trigger in flight — head unchanged
throughout, no pushes, no reruns. At 16:46:26Z all five workflows were created
in a single batch, and all five concluded `success`. Two of them, `Tests` and
`Playwright Tests`, had never been created at that head at all, 95 minutes
after the push that should have produced them. So this is also the only
end-to-end confirmation in this document that the lever recovers the
never-created case rather than merely re-firing what already existed.

PR #1271, same lever under the same conditions, went the other way: reopened
17:37:05Z, five runs created 17:37:17Z — **twelve seconds**, four of them
already `success` seven minutes later.

So a determined pairing does not buy you a predictable delay; the unambiguous
measurements are 10 minutes and 12 seconds. An earlier draft of this section
added a third claim — that they also shared a *single* batch, and that partial
fan-outs might therefore be an artefact of pairing runs to the wrong trigger.
**That is false.** #1277's 15:44:40Z reopen is equally determined: two
`commented` events, then close/reopen, no push and no rerun in between. It
still split into two batches, 9 seconds and 13 minutes apart. (#1277 does have
a second close/reopen, at 16:21:43Z/16:21:44Z — it lands *after* both batches
and so leaves the pairing intact.) Partial fan-out is a behaviour of the lever,
not a measurement error.

What does survive at n=3 is **completeness**: all three determined pairings
delivered all five expected workflows eventually — one batch at +12s, one batch
at +9m49s, two batches at +9s and +13m16s. Delay and batch count are both
unpredictable; the final count is not. Do not plan around any of the numbers.

Note what made these two measurable: exactly one trigger and exactly one batch.
The delay is not unknowable in general — it is unknowable whenever you have more
triggers in flight than batches to match them to, which is the situation you
create by re-firing a second time while waiting.

Practical consequences:

- Do not conclude "the re-trigger did nothing" inside ~25 minutes. Both of us
  did, at 2 and 17 minutes.
- Do not conclude it worked because *some* runs appeared. Count the workflows
  you expect, not whether the list is non-empty. Derive that number rather than
  reusing this document's five: eight workflow files declare `pull_request`, and
  for these three PRs `Deploy Docs` (`paths: docs-site/**`) and `Smoke Tests`
  (`paths: k8s/**`, the two Dockerfiles) did not match the diff while
  `Release Safety` is `branches: [ v1.0.x ]`, leaving five. A workflow with no
  `types:` key defaults to `[opened, synchronize, reopened]`, so none of the
  five is excluded from a reopen — but check, because one that pinned
  `types: [opened, synchronize]` would legitimately never come back and would
  read as a missing run forever.
- **Your expected count is not the whole check list.** CodeQL default setup runs
  as `path: dynamic/github-code-scanning/codeql`, `event: dynamic`, with no file
  in `.github/workflows/`. Close/reopen does not re-dispatch it, so its three
  `Analyze` checks stay on whatever state they were already in while the five
  workflow runs come back green.
- The arriving runs are fresh ids at `run_attempt=1`; they never reuse the run
  you were watching, so watching that id shows you nothing either way.

## The rerun refusal is not about the run's conclusion

`gh run rerun` answering `cannot be rerun; This workflow is already running`
is a **concurrency-group** condition, not a terminal-state one. `tests.yml`
groups on `${{ github.workflow }}-${{ github.event.pull_request.number ||
github.sha }}` with `cancel-in-progress: true`, so a queued run for the same PR
blocks a rerun of an older one. Clearing the queued run — or waiting — makes the
same command succeed on the same id. A refusal is not evidence that the class
of run is unrerunnable.

## Order to work in

1. `gh run list --branch <branch>` — or better,
   `gh api "repos/<o>/<r>/actions/runs?head_sha=<sha>"`. Does a run exist at
   this head SHA at all?
   `gh pr checks` cannot answer this; a never-created run and a queued run are
   the same empty row there.
2. If it exists, `gh api .../runs/<id>` for status, and
   `.../jobs?filter=all` for what actually executed, per attempt.
3. Join on SHA before concluding anything. A run listed on the branch may
   belong to a previous head.

Related: PR #1240 proposes a review-checklist rule that a join across two
measurements needs a time-invariant predicate — the same failure one layer up.
Step 3 above is that rule applied to a single PR.
