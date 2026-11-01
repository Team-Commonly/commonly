---
name: working-in-turns
description: Keep each turn bounded, checkpointed, and reviewable.
user-invocable: false
last_updated: 2026-11-01
---

# Working in Turns

- End each turn before its run limit, not at it. The default run limit is 15 minutes, and only adapters that honor `COMMONLY_AGENT_RUN_TIMEOUT_MS` can use a longer one such as `2700000` (45 minutes). On a 45-minute limit, end the turn by about 35 minutes; on the 15-minute default, by about 10. Before ending: commit and push what you have (an open PR is enough; open it ready), and post the next step as a one-line note on the row. The next wake continues from the pushed branch. If the work is larger, split it and say how in the row. A timeout sends SIGTERM and loses uncommitted work.
- Open your PR as ready, not as a draft. A later `gh pr ready` can be refused by the harness's permission classifier ("Unrequested Commit in a Connected App") when your turn never said to undraft. That refusal comes from the harness, not from the seat `gh` fence.
- **One review round per change.** Before you hand a PR to the press, run your own quick subagent review of its diff. Tier 2 changes (auth, grants, record, schema, wake, money, security) need an Opus-class reviewer. That one review also covers screenshots against the design frame, any lane checks and the zh-CN glossary. Don't ask a second reviewer, and don't ask anyone to re-review after you push a fix.
- Then answer every CodeRabbit thread and get CI green. A push that only answers CodeRabbit or CI keeps your PASS.
- If your review comes back HOLD, fix it, push, and review again yourself.
- File the verdict as described in [review checklist rule 44](https://github.com/Team-Commonly/commonly/blob/main/docs/development/review-checklist.md#what-a-clearance-can-bind) and [rule 51](https://github.com/Team-Commonly/commonly/blob/main/docs/development/review-checklist.md#where-a-verdict-is-readable): the first line names the head you reviewed and the verdict, and the final non-blank line is the bare `GATE: PASS` or `GATE: HOLD` sentinel.
- After filing a verdict, choose a checkout strategy: inspect and remove/prune a temporary PR checkout only after checking for uncommitted work, or keep one reusable checkout and clean/refetch it for the next review.
- Never use `git worktree remove --force` before checking for uncommitted work.

## Gate ask template

Use this only when you can't run your own subagent review, for example a
seat with no shell. Ask one reviewer, in a pod they belong to, and include the
PR number, exact head SHA, files or properties to check, and the required
verdict form:

> Please review PR #<number> at `<full-head-sha>`. Check `<files/properties>`.
> File the verdict as a PR review. Its first line must be `HEAD: <full-head-sha>
> — GATE: PASS` or `HEAD: <full-head-sha> — GATE: HOLD`, and its final
> non-blank line must be exactly `GATE: PASS` or `GATE: HOLD`, per review
> checklist rules 44 and 51. After filing it, inspect a temporary checkout for
> uncommitted work before removing it and pruning; otherwise clean and refetch
> the reusable checkout for the next review.

Use one reusable checkout per seat when appropriate; inspect temporary checkouts before removing them.
