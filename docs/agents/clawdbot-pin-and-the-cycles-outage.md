# The `_external/clawdbot` submodule pin and the 88-day `cycles` outage

**Status: RESOLVED 2026-08-05 by #840, and guarded in CI by
`scripts/verify-moltbot-tool-contract.js`.** Kept because the failure mode is
durable, the guard is young, and this file is the only record of how three
separate people were confidently wrong about the same 25-tool block in both
directions.

Moved out of CLAUDE.md 2026-08-18: it is resolved history, and CLAUDE.md is
loaded into every agent's context on every turn. The operative rule stays there;
the archaeology lives here.

---

- **RESOLVED 2026-08-05 by #840 — read the resolution before the history below.** The two openclaw lineages were reconciled: `70bd82b80f` ("feat(commonly): forward-port runtime collaboration tools") is **on `origin/main`**, declares **30** `commonly_*` tools, and carries all six that were previously split across the two lineages — `log_cycle`, `open_dm`, `read_attachment`, `read_my_memory`, `save_my_memory`, AND `react_to_message`. `.gitmodules` now declares `branch = main`, so the declaration and the pin finally agree. **Verified in the running gateway container, not the source tree** (image tag `1e7be859`, probed 2026-08-05: 30 declared, positive control run). The prescribed cherry-pick below was executed as a forward-port; `scripts/verify-moltbot-tool-contract.js` now enforces both invariants in CI (tool contract + pin reachable from the declared branch) so a future bump goes red instead of the fleet going quiet.

  **The history is kept because the failure mode is durable and the guard is young.** Everything from here down describes the state before #840 — it is no longer what runs:

- **`_external/clawdbot`'s pin ALTERNATED between two diverged openclaw lineages, and every bump silently swapped the whole tool set.** This was not a stale pointer nobody moved. It was moved 15+ times, and it crossed lineages repeatedly:

  ```
  2026-05-09  f4b7a487  a67f0df6  BRANCH rebase-2026.3.29   log_cycle ARRIVES
  2026-05-17  b6a811bd  fc6a2231  main lineage              log_cycle LOST   (bump was for react_to_message)
  2026-05-21  0168f013  a67f0df6  BRANCH                    log_cycle RESTORED (#418, explicitly)
  2026-05-24  d6e63b2e  84549161  main lineage              log_cycle LOST   (bump was for bundled-skills)
  2026-06-26  a3de6d07  00821479  main lineage              ← current pin
  ```

  | (HISTORICAL — superseded 2026-08-05) | `commonly_*` tools | has | lacks |
  |---|---|---|---|
  | ~~pin `0082147920`~~ — what ran until #840 | 25 | `react_to_message` | `log_cycle` `open_dm` `read_attachment` `read_my_memory` `save_my_memory` |
  | ~~`rebase-2026.3.29`~~ — formerly declared in `.gitmodules` | 29 | those five | `react_to_message` |
  | **pin `70bd82b80f` on `main` — what runs NOW** | **30** | **all six** | — |

  **Three authors, three unrelated features, each silently dropping five tools.** `#418`'s subject is literally `bump _external/clawdbot fc6a22319 → a67f0df63` — somebody caught this exact regression on 05-21 and fixed it, and a bundled-skills bump undid it three days later. Nobody was negligent; the bump surfaces the tool it was made for and nothing about the ones it trades away.

  Independently cross-validated (@ux-lead, 2026-08-04): per-agent last-`cycles`-append timestamps cluster at 2026-05-09…05-13 and 2026-05-21…05-23, **both strictly inside a branch-pinned window, with nothing outside them.** Mongo timestamps and the submodule log agree to the day.

  **So the fix is not a bump in either direction — it is ending the divergence.** *(DONE — #840 did exactly this, as a forward-port onto `main` rather than the cherry-pick sketched here. The collision analysis below is why it was a forward-port. The `cycles` silence had this skew as its cause; the cause is now removed and the tool is live in the deployed gateway, so a fleet still silent after LLM recovery needs a NEW explanation, not this one.)* Until then the next person adding a tool re-breaks this without knowing; three already have. **Cherry-pick `a67f0df6` (and any of `open_dm read_attachment read_my_memory save_my_memory` still wanted) onto openclaw `main`, then move the pin to that new main** — and **do not port the branch's 14 commits wholesale**, which collides twice:

  - branch `6c99dc31` (`tools.ts` +11/−2, *route acpx_run through LiteLLM via opencode agent*) adds to the region main **deleted 73 lines from** in `2ce923b6`. Porting re-introduces rotation logic main removed on purpose.
  - `commonly_attach_file` exists on **both** lineages as independent implementations — branch `8b50281b` (+125 `tools.ts`, +43 `client.ts`, +9 `src/plugin-sdk/index.ts`) vs main `00821479` (+22 / +68). A wholesale port yields a duplicate registration of the same tool name, in different regions of different files, so **git may not raise a conflict at all.**

  The one-commit port is provably clean by contrast: `a67f0df6` touches only `extensions/commonly/src/tools.ts`, **+36/−0**, pure addition. Same-named tools on two lineages are not agreement — check implementations, never names.

  Why it survives being caught: **a submodule bump never touches `.gitmodules`, and its diff shows one line of hex.** `git -C _external/clawdbot checkout <sha> && git add _external/clawdbot` puts neither the declaration nor the tool-set delta in front of a reviewer. `#418` proves the regression is *findable*; it also proves finding it once doesn't hold, because the next unrelated bump reverts it invisibly.

  **`.gitmodules`' `branch = rebase-2026.3.29` is read by nothing in the build** — it is not what selects the lineage. But it is not merely decorative either: it records an intent the pin honoured twice and abandoned three times. Reconcile the lineages and then make it true or delete it; leaving it is how the next person concludes the branch is what ships. *(DONE — `.gitmodules` now declares `branch = main` and the pin is an ancestor of it; `verify-moltbot-tool-contract.js` asserts that reachability, so the declaration cannot drift back into decoration.)* This skew was the cause of the moltbot `cycles` silence, **corroborated to the day by the memory collection** (measured 2026-08-05): the newest `cycles` entry on any `agentName=openclaw` doc is `2026-05-24T08:49:56Z` — the same day as the `d6e63b2e` bundled-skills bump that dropped `commonly_log_cycle`. All 22 moltbot arrays sit at the 40-entry cap: they wrote until the tool vanished and stopped dead, so the arrays are FULL, not empty. **The silence is moltbot-scoped, not fleet-wide** — 13 non-moltbot seats (MCP/wrapper) kept writing throughout, several the same evening this was measured. Any recovery check must filter to `agentName=openclaw` and look for an entry newer than 05-24, or it will read healthy off seats that were never affected.

  An earlier version of this entry said the bump "gains five tools and loses `react_to_message`, so it owes a diff of both tool sets." **A tool-set diff shows none of the OAuth or build-arg commits** — the rule was scoped to the surface that raised the question. The check is a diff of the **commit range**.

  **Rule this earned:** a claim about a tool in another repo needs the **ref** and something that reads it. Three separate entries in this file were wrong about the same 25-tool block, in both directions, because each named the tool and not the ref. `presets.ts` carries the same table beside the trailer.
