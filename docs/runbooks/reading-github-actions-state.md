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
| Queued, pool saturated | grey/pending | run exists, `status=queued`, age climbing | wait — re-triggering adds to the back of the line |
| Superseded by concurrency | run `cancelled` | a NEWER run exists at a newer SHA in the same group | none needed; read the newer run |
| Jobs cancelled at 0 steps | run `failure` | jobs `cancelled`, `steps=0`, and no newer run to have superseded them | `gh run rerun <id>` |
| Orphaned jobs | check shows **`pending`, forever** | run `completed/failure`, jobs still `queued/null` at `steps=0` | `gh run rerun <id>` — waiting never resolves it |

Two of these mislead in opposite directions. A run-level `failure` reads as
"the tests failed" when nothing ever executed. And a check row reporting
`pending` can belong to a run that terminated over an hour ago: the row
inherits its **job's** status, and a job orphaned by a terminating run stays
`queued/null` permanently. `gh pr checks` will show it as pending until the
head moves.

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
`status=queued conclusion=null`. The job records were already terminal. When
the two disagree, the per-attempt job listing is the one that has run.

## Check-suites separate never-dispatched from dispatched-and-stuck

This is the sharpest instrument in this document, and it answers the question
the run list cannot: was the workflow ever dispatched at all? Every dispatched
workflow allocates a `github-actions` check-suite within seconds, *whether or
not its run ever starts*. So:

```bash
gh api "repos/<o>/<r>/commits/<sha>/check-suites?per_page=50" \
  -q '.check_suites[] | "\(.created_at) app=\(.app.slug) \(.status)/\(.conclusion) runs=\(.latest_check_runs_count)"'
```

Measured at PR #1216's head on 2026-08-26: three `github-actions` suites created
15:08:11, 15:08:13 and 15:09:50, all `queued`, one per stuck guard workflow —
and **no suite at all** for `Tests` or `Playwright Tests`. Those two were never
dispatched. At PR #1277's head, two suites sit at `completed/startup_failure`
with zero runs, which is the terminal state-1 case wearing the same face.

**Do not key on `latest_check_runs_count`.** A dispatched-but-queued suite
reports `runs: 0`, identical to an empty one. The suite's *existence at that
sha* is the signal; its count is not.

One collection caveat that cost time here: CodeQL and other app-driven runs are
recorded against `refs/pull/<n>/head`, not the branch, so
`?branch=<branch-name>` can return zero for a PR that visibly has runs. Query
by `head_sha` or via the commit's check-suites instead.

## A re-trigger fans out partially, and stragglers arrive minutes later

Close/reopen re-fires `pull_request` workflows without moving the head, which is
what makes it the right lever over an empty commit when a run was never created.
It does work. But it does **not** deliver the whole fan-out at once, so an early
check tells you almost nothing.

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

Practical consequences:

- Do not conclude "the re-trigger did nothing" inside ~25 minutes. Both of us
  did, at 2 and 17 minutes.
- Do not conclude it worked because *some* runs appeared. Count the workflows
  you expect, not whether the list is non-empty.
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
