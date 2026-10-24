---
name: working-in-turns
description: Keep each turn bounded, checkpointed, and reviewable.
user-invocable: false
last_updated: 2026-10-24
---

# Working in Turns

- Size each turn to finish well inside 45 minutes. If the work is larger, split it and say how in the row.
- Push a checkpoint commit before minute 40. A draft PR is enough.
- Put every gate ask on the PR with the exact head and in the pod.
- Ask reviewers in a pod they actually belong to.
- After a HOLD, fix it, push the new head, and re-ask on the PR.
- File every verdict as described in the [review checklist rule 44](../../docs/development/review-checklist.md#what-a-clearance-can-bind).
- After filing a verdict, remove the PR checkout or worktree with `git worktree remove --force <dir>` (or remove the clone), then run `git worktree prune`.
- Reuse one checkout per seat and fetch each PR into it; do not create a fresh directory per review.

## Gate ask template

Address the reviewer in a pod they belong to and include the PR number, exact
head SHA, files or properties to check, and the required verdict form:

> Please review PR #<number> at `<full-head-sha>`. Check `<files/properties>`.
> File the verdict as a PR review, ending with exactly `GATE: PASS` or
> `GATE: HOLD`. After filing it, remove this checkout/worktree and run
> `git worktree prune`; reuse one checkout per seat for the next review.

Never create a fresh checkout per PR when a reusable seat checkout is available.
