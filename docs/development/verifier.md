# Verifier protocol

A verifier is a fresh-context subagent. It never sees the builder's reasoning. It gets four things:
- the PR number and head SHA;
- the feature (from `feature_list.json`) or the unit's brief;
- the repo at that head;
- this file.

It runs on a different model from the builder.

## What it does, in order
1. **Reproduce.** Check out the head and run `./init.sh`, then the feature's `test` command. A red
   result ends the review with `verifier-failed`.
2. **Acceptance.** Walk each step of the feature or brief against what the test actually asserts.
   A step that no assertion covers is a finding.
3. **Review.** Apply Pocock `code-review` to the diff against base `v4`. Correctness comes first; then
   the contract (schema to generated code, server-stamped fields, token scope).
4. **Deslop.** Apply pstack `deslop` (`docs/skills/pstack-deslop/SKILL.md`, base `v4`). Look for dead code,
   needless abstraction, comments that restate code, and over-defensive guards.
5. **Subtract.** Answer two questions: could the diff be smaller, and does it delete anything it made
   obsolete?
6. **Entropy.** Report lines added and removed (`git diff --shortstat origin/v4...HEAD`) and the LOC
   lines printed by `make entropy`.

## Verdict
The last lines of the report are always these, in this order:
```
LEDGER <pr> <head-sha> <unit-test-verified|live-ui-verified|type-check-only|verifier-blocked|verifier-failed>
FINDINGS <n blocking> <n non-blocking>
GATE: PASS | GATE: FAIL
```
- `GATE: PASS` requires zero blocking findings.
- The verifier never pushes, comments on GitHub or merges. The coordinator records the ledger row and
  posts the review.
- A protected-path PR still needs lumen's Opus `GATE: PASS` at the same head.
