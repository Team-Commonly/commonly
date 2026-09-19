# Landing a PR when `main` moves under you

Four finished, fully gated PRs sat unmerged for six hours on 2026-09-18 and were
rebased six times before the queue cleared. Nothing was wrong with any of them.
The gap was written-down knowledge: **what has to be true for the merge button to
exist at all**, and who can make it true. This is that note.

## Measure the two settings first

```bash
gh api repos/Team-Commonly/commonly/branches/main/protection \
  -q '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
gh api repos/Team-Commonly/commonly -q '{allow_auto_merge, allow_update_branch}'
```

Measured 2026-09-18: `strict: true`, required contexts `["Test & Coverage"]`, no
required reviews, **`allow_update_branch: false`**, **`allow_auto_merge: false`**.

Three consequences, none of them visible from a green PR page:

1. **A green PR that is `BEHIND` cannot be merged by anyone.** The merge button
   is disabled by protection. If a queue is stalled, this is the first thing to
   check — it is very easy to misread as the reviewer or the presser hesitating.
2. **There is no UI remedy.** "Update branch" is hidden while
   `allow_update_branch` is false, and auto-merge is off. `gh pr edit <n> --base
   main` retargets a base but does not *update* a branch. The only way to clear
   `BEHIND` is to rebase the branch and push.
3. **Every merge to `main` flips every other open PR to `BEHIND`.** One press
   per window, not N presses.

Read the state per PR rather than trusting the list view:

```bash
gh pr view <n> --json mergeStateStatus,mergeable,state \
  -q '"\(.state) \(.mergeable) \(.mergeStateStatus)"'
```

`MERGEABLE` + `BEHIND` means *everything else is already satisfied*. That pair is
the signature of this problem.

## Instruments that fail toward "fine"

Two measurement mistakes cost this pod a wrong public claim on 2026-09-19. Both
return the **reassuring** answer when they are wrong, which is why reading the
result does not catch either one.

**A local `origin/main` is not the base.** Any locally-resolved ref —
`git rev-parse origin/main`, a cached compare, an editor's view — can lag the
server. Measured: a compare against local `373ac260` reported `behind=0`, and the
PR was announced as "pressable now, no rebase needed" while server-side `main`
was `d5afd20d` — behind 1 and unpressed. `mergeStateStatus: BEHIND` was right and
the instrument was wrong. Ask the server instead:

```bash
gh api repos/Team-Commonly/commonly/commits/main -q .sha
```

The same stale baseline silently undercut a peer's file-overlap analysis of the
two heads; re-run against server-side `main`, the conclusion survived — but it
survived because it was re-measured, not because it was still true.

**A name-filtered check query hides the failing check.** Ask `check-runs` for
names you guessed and you get back only those names. On one head
`Analyze (javascript-typescript)` — the analysis *job* — was `success` while
`CodeQL` — the alert *gate* — was `failure`, so a filter written around
"Analyze" reports a clean PR that the queue may still refuse. Enumerate first,
then filter:

```bash
gh api "repos/Team-Commonly/commonly/commits/<sha>/check-runs?filter=all&per_page=100" \
  -q '.check_runs[] | "\(.conclusion) \(.name)"'
```

Both mistakes have the same shape: the instrument excludes the member it was
written to find, and the omission reads as a pass. When two instruments disagree
about whether you are current, the server is right.

**A failure you filter in the pipeline loses its cause.** On 2026-09-19 one run of
the 5-suite set at byte-identical content reported `21 failed / 87 passed`. 21 is
exactly one suite's test count, which is the shape of a suite that failed to
*initialise* rather than 21 broken assertions — but that is all that can be said
about it, because the output had been piped straight into `grep` and the
`Test suite failed to run` block, the one that names the cause, was never written
anywhere. A peer then ran the same set 10 times (6 serial, 4 concurrent, to test
the load theory) and got 108/108 every time. Unreproducible, and now unfindable.

Redirect to a file, then filter the file:

```bash
npx jest <paths> > /tmp/run.log 2>&1
grep -E "^(Tests|Test Suites):" /tmp/run.log
grep -nE "Test suite failed to run|Cannot find module" /tmp/run.log
```

The total is what you report; the block is what you would need to explain it. A
green run throws nothing away, so keeping the log is only paid on the run that
matters — and a flake you cannot explain is a flake the next person does not
believe.

## The window, and why it feels like a treadmill

Rebasing buys a window that closes on the next merge to `main`. On 2026-09-18
`main` was taking a merge roughly every 20 minutes and the CI set takes 10–14
minutes, so a given PR was simultaneously green *and* current about half the
time. Practical rules:

- Rebase **immediately before** asking for a press, not hours before. A rebase
  that is four merges old has bought nothing.
- Re-check `mergeStateStatus` at the moment of the ask. Asking on a `BEHIND` PR
  transfers the problem to whoever is pressing.
- If the presser is doing the rebases themselves, stop rebasing. Two people
  rebasing the same branches is churn, and their rebase keeps the patch-id.

## Re-pinned gates are cheap — use patch-ids

A head rewrite does not invalidate a review if the content is unchanged:

```bash
git show <sha> | git patch-id --stable | cut -d' ' -f1
```

Identical patch-id ⇒ identical diff ⇒ the gate carries to the new head. This is
the standing arrangement in these pods: reviewers re-stamp by patch-id on
request-free.

**But the implication only runs one way, and I learned that by being wrong out
loud.** Patch-id is computed over the diff *including its context lines*, so it is
context-sensitive. On 2026-09-19 a rebase of #1751 onto a main that had rewritten
`routes/grants.ts` around its hunks changed one commit's patch-id
(`52ab307a` → `15adc250`) while the change itself had not moved a byte — verified
by diffing the patches' `+`/`-` lines, which came out empty. I had already told
the pod "all four patch-ids unchanged, so the gated content is byte-identical",
and that sentence was both the wrong instrument and the wrong direction:

- **identical patch-id ⇒ the gate carries.** Still true, still the useful
direction, and still how a rebase is cheap.
- **a *changed* patch-id ⇒ nothing at all about your change.** It may have moved,
  or the base may have been rewritten underneath it. Never report it as a content
  change, and never skip a rebase because of it.

When a patch-id moves, diff the content and find out which happened:

```bash
git show <old> | grep -E '^[+-]' | grep -v '^[+-][+-]' > /tmp/old.txt
git show <new> | grep -E '^[+-]' | grep -v '^[+-][+-]' > /tmp/new.txt
diff /tmp/old.txt /tmp/new.txt && echo "same change, new context"
```

An empty diff means the rebase was a rebase. Publish *that* measurement, not the
patch-id — the patch-id is a shortcut for the common case, not the evidence.

## Stacked PRs are rejected here, by design

`.github/workflows/pr-base-guard.yml` ("PR targets main") fails any PR whose base
is not `main`; it deliberately has no `branches` filter so it can see stacked
children. A stacked child also runs a **shorter** check set — measured on
2026-09-18, 14 checks on a `main`-based PR against 5 on the stacked child (the
child skipped CodeQL, the stale-base guard and the version guard). A stacked
green is short, not clean.

If a parent genuinely must land first: say so on the PR, land the parent, then
`gh pr edit <n> --base main` and rebase.

Retargeting alone does not re-run the guard — it triggers on `opened`,
`synchronize`, `reopened`, `ready_for_review` and **`edited`**, and a check that
has already run keeps the base it recorded. So the red clears on the next fresh
run (a push, or a PR-body edit), **not** on the retarget itself, and
`gh run rerun` on the old run re-tests the old base and stays red. Measured by
lily-shen on #1732's retarget, 2026-09-18.

**GitHub does not retarget a PR when its base branch merely merges** — it
retargets when the base branch is *deleted*. Measured the same day: #1732's base
was still `fix/task-131-relative-now` after #1728 had squash-merged into `main`,
so the retarget was not automatic and had to be set explicitly.

### The `--onto` case (squash-merged parent)

If the parent was **squash-merged**, a plain `git rebase origin/main` will replay
the parent's commits too: a squash produces one commit whose patch-id matches
neither parent commit, so git cannot see them as already present. Replay only
your own work:

```bash
git rebase --onto origin/main <old-parent-sha> <branch>
git push --force-with-lease origin <branch>
```

Pass the old parent **sha**, not a branch name — the branch ref may have moved
(or been rebased) by the time you run this. Then verify instead of trusting it:

```bash
git diff --stat origin/main...<branch>   # should list only your own files
```

## What not to do

- Don't tell a human to click "Update branch" without checking
  `allow_update_branch`. On this repo that button does not exist, and the remedy
  is one that a reader can neither use nor debug.
- Don't park finished, gated work behind a local commit while waiting. Open the
  PR even if it cannot be pressed yet — a branch with no PR reads as unstarted
  to everyone but its author.
- Don't run the rebase loop silently. If it is going to repeat, say what it costs
  and who is paying it; if the answer is a human, escalate once with the numbers
  rather than re-running the loop.

## Related

- `docs/runbooks/reading-github-actions-state.md` — when the *checks* look wrong
  rather than the freshness. Different failure, different readers.
- `.github/workflows/pr-base-guard.yml` and
  `.github/workflows/pr-base-freshness.yml` — the two guards cited above; read
  both, they encode different policies. The base guard's own header also carries
  the measured numbers for an earlier stack (4–5 checks on the children against
  ~12 on a `main`-based PR).
