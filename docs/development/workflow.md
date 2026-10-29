# How v4 is built

v4 is built by one long-running builder session, using the harness from Anthropic's
[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

| File | Role |
|---|---|
| `feature_list.json` | Every slice feature, written as an end-to-end test. Only `passes` may change. |
| `init.sh` | Brings up the environment, runs the baseline and prints the scoreboard. |
| `progress.md` | The hand-off between sessions and across context compactions. |
| git log | The record. Small commits, one feature per PR. |

## Why each rule exists
- **The feature list is JSON and tests are never edited.** The article found that models rewrite
  Markdown checklists. Removing a test to make it pass is the failure that hides missing
  functionality.
- **One feature at a time.** Long runs fail by declaring done too early or by half-finishing several
  features. Taking the top unfinished feature every time prevents both.
- **The baseline runs first.** A session that builds on a broken tree compounds the break.
  `init.sh` makes the state visible before any edit.
- **Verify at the API, not with unit tests.** The article saw agents mark features done on unit
  tests or a single curl. Here a feature passes only on its `test` command. For the slice, that is
  the Go e2e that drives the real Worker and daemon. Browser checks join when the client lands (F18).
- **Compact at feature boundaries.** `progress.md` plus git carry the state, so a fresh context can
  resume without the transcript.

## Stage skills
| Stage | Skill | When |
|---|---|---|
| Plan and build | Pocock `tdd` | Every feature: e2e red, then unit red/green/refactor inward |
| Review | Pocock `code-review`, run in a fresh-context subagent | Protected-path PRs, before the Opus gate |
| Retro | pstack `reflect` (coordinator only; vendored in the skills repo, `pstack/reflect`) | At the end of each lane, or after a surprise |
| Entropy | pstack `deslop` (`docs/skills/pstack-deslop/`) | Every verifier pass, and the removal-only unit each wave |

## Review and merge
- Green in the merge queue merges.
- A PR touching a protected path also needs two reviews before it merges:
  - one fresh-context review: a subagent given the diff and the feature, not the builder's reasoning;
  - an Opus `GATE: PASS` at the PR head (lumen).
- Protected paths: `schema/`, `worker/src/auth`, `worker/src/mcp`, `daemon/internal/{acp,run}`,
  `install.sh` and `.github/workflows`.
- The press for `main` (D162) does not apply to `v4`.

## Design-gated features
- **F18 (client) and F19 (connectors)** stay blocked until their options docs are reviewed with Sam.
  The docs are `docs/design/client-options.md` and `docs/design/connector-options.md`.
- **After the review:**
  1. add the steps and test to the existing F18 or F19 entry, and clear `blockedBy`;
  2. note in `progress.md` that the review set them.

  This is the only time a feature's text changes, and only for these placeholders.

## Entropy gate
Maintainability is a gate in the loop, not a cleanup phase. `make preflight` runs `make entropy`, and
so does CI.
- **Budgets** live in `entropy.json`:
  - each file at most 400 lines and each function at most 60;
  - a LOC cap per area;
  - `TODO` only with a row id, like `TODO(F07)`;
  - Go import boundaries;
  - exceptions only shrink, unless a new one cites a `docs/adr/` note.
- **Dead code:** knip (TS), staticcheck and deadcode (Go).
- **Boundaries:** dependency-cruiser (TS).
- **Every unit report** states its lines added and removed, and answers the subtract-before-you-add
  question: what did this change make obsolete, and was it deleted?
- **New dependencies:** a new dependency or module gets a short note in `docs/adr/`.
- **Each wave** includes one removal-only unit:
  - `deslop` plus Pocock `codebase-design`, with no new behaviour;
  - a `docs/INDEX.md` drift check;
  - quarantining any flaky test, with a fix row.
- **Next, once the slice is green:** jscpd duplication and a full ratchet report.
