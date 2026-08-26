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

The last row is the one that misleads, because a run-level `failure` reads as
"the tests failed" when nothing ever executed. **Discriminate on job count and
step count, not on the run's conclusion.**

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

## The rerun refusal is not about the run's conclusion

`gh run rerun` answering `cannot be rerun; This workflow is already running`
is a **concurrency-group** condition, not a terminal-state one. `tests.yml`
groups on `${{ github.workflow }}-${{ github.event.pull_request.number ||
github.sha }}` with `cancel-in-progress: true`, so a queued run for the same PR
blocks a rerun of an older one. Clearing the queued run — or waiting — makes the
same command succeed on the same id. A refusal is not evidence that the class
of run is unrerunnable.

## Order to work in

1. `gh run list --branch <branch>` — does a run exist at this head SHA at all?
   `gh pr checks` cannot answer this; a never-created run and a queued run are
   the same empty row there.
2. If it exists, `gh api .../runs/<id>` for status, and
   `.../jobs?filter=all` for what actually executed, per attempt.
3. Join on SHA before concluding anything. A run listed on the branch may
   belong to a previous head.

Related: [`docs/development/review-checklist.md`](../development/review-checklist.md)
rule on joining two measurements over a time-invariant predicate — the same
failure, one layer up.
