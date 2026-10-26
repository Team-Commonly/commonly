# Fleet efficiency: how seats and leads spend turns, models and quota

**House rules, set by Sam on 2026-10-25** ("really need to handle them well, especially the efficiency
and productivity … don't let it drift"). They hold for every seat and every lead session. Each rule
names what earned it.

## 1. Models: a writer switches, it never parks

- **Writers run on the cheapest model their row allows.** General rows go to DeepSeek V4.1 Flash 1017
  under the sandboxed dsh config once that config is approved. Until then, they go to Claude Haiku 5.5.
  Kernel, auth, grant, record and security writing goes to Claude Opus 5.5. No other row goes there.
- **Hosted agents reach Claude only through the model API**: OpenRouter, or the user's own key. Never
  hold, broker or pay for a user's Claude subscription or session token. Claude Code stays bring-your-own.
- **A blocked writer switches to its next allowed model.** The order is primary, then Haiku, then
  DeepSeek, skipping any harness its row's tier forbids. A writer is never left idle while work is
  ready. If every allowed harness is blocked or down, the turn fails visibly. No model is ever
  substituted silently.
- **A refusal never switches harness.** When a provider refuses content, sending the same content to
  another provider is refusal-shopping. Reword the ask (see
  [who-to-address.md](who-to-address.md) on gate asks to codex seats) or take it to a person.
- **Claude quota is shared with the operator.** Claude seats run behind a slot limit and stop starting
  turns on the first rate-limit error. Haiku draws on the same quota, so a rate-limit stop halts Haiku
  and Opus seats together, and the relief is the next non-Claude harness in the switch order. Before a
  stop, while quota is only running low, small rows run on Haiku because it spends far less of that
  quota per turn, and no row moves up to Opus.

Earned 2026-10-25: the codex workspace ran out of credits mid-evening, every codex writer stopped at
once, and the first fix parked them. Parked writers did no work while 139 ready rows waited.

## 2. Work allocation: rows find seats

- **No PM or HR agents.** An operator router gives a ready, unowned row in a lane to an idle writer
  in that lane, choosing by the row's explicit risk tier: `opus`, `general` or `small`. A row with no
  tier is not routed. An Opus seat takes opus-tier rows only.
- **A routed row arrives as one assignment and one mention in its own pod.** Claim it, or release it
  with one line saying why. A released row never goes back to the seat that released it.
- **Rows older than 14 days are not routed.** Their lead triages them first: close the stale ones,
  re-file the real ones.
- **File rows the router can use.** A row needs a single owner-scoped job, its acceptance line, its
  deps, and a tier from its lead. A row that names an owner session in its title (`(SWE)`,
  `owner: SRE`) is that session's, and is not routed.
- **"Blocked" and "idle with ready work" are different states.** Blocked means switch harness. Idle
  with ready work means route.

Earned 2026-10-25: 139 ready rows had no owner, with a median wait of 69 h (p90 784 h), while 11 of
15 writers held no ready row.

## 3. Wakes: receiving a message is not a reason to take a turn

- **Every turn is paid.** If a wake gives you nothing to do, your whole output is exactly `NO_REPLY`.
  Never narrate why you aren't acting, because the final text is posted unless it is exactly
  `NO_REPLY` (CLI wake prompts, #2741). On 10-25, 62% of turns were empty when measured from the
  event join.
- **Read in parallel, keep the conclusion.** When a row needs several files or sources read, a Claude
  seat spawns read-only subagents with the Agent tool, names the files and the question, and keeps
  only the answers (seat prompt, #2730). A row too large for one turn is split into owner-scoped
  child rows before any code.
- **A row you created for yourself gets at most one wake**, then waits for a person (#2757).
- **A pod holds at most 5 agents.** Each pod has a pinned goal, a done condition and a lead. One seat
  may belong to several pods.
- **No FYI mentions.** Mention only the seat you are asking (see [who-to-address.md](who-to-address.md)).

## 4. Shipping

- **Gate by risk tier.** The writer names the tier. A reviewer may raise it, never lower it.
  - Tier 0, docs or tests only: every CodeRabbit thread answered and CI green, then a hand press. No
    seat gate.
  - Tier 1, UI, copy or flag-off code: one seat gate, plus the 390 and 1440 walk.
  - Tier 2, auth, credentials, security, schema, wake or routing, billing: two seat gates, one of them
    from a model other than Haiku.
- **Never edit the version line** of `cli/package.json`, `commonly-mcp/package.json` or `server.json`.
  The version is assigned at publish time.
- **Prod deploys are capped at one a day**, batched and after a green staging smoke. The P0 and
  security exemption exists but is rare.
- **A merge is not a deploy.** Under a deploy freeze, the press keeps merging gated, clean PRs.
- **The fleet's GitHub REST quota is shared.** Any tool that paginates or polls GitHub checks the
  remaining budget first and skips its cycle when it runs low. Don't add a poll loop that skips the
  check.
- **Measure from the right sample.** A CI-time or regression claim cites the runs it sampled:
  merge-queue and PR runs at the head, not stale `main` runs. On 10-25 a CI regression was called from
  stale `main` runs, and it did not exist.

## 5. Building

- **Adopt an outside project only if it deletes our code.** Its entropy number is our lines deleted
  minus the glue we add. A zero or negative number means study it and don't adopt it.
- **An upstream bug never blocks us.** Every upstream bug gets a workaround on our side, in the
  adapter or the supervisor. Reporting it upstream is a courtesy, never a dependency.
- **Paper first when two unknowns decide feasibility**, then build. For example, the key injector
  hinged on base-URL support and on scrubbing a key split across chunks.
- **Reuse before you build.** Look for the existing piece first. The CLI's provider proxy already
  injects keys and scrubs responses, so new run types sit behind it rather than a second proxy.

## 6. Claims

- **A public sentence names only what a non-author has walked on prod.** Credential, grant and record
  wording follows what is walked, not what is planned. Until per-task grants are walked, a grant is
  "scoped to a pod and an agent, and can expire or be revoked". A record is "each connector call
  through a grant is recorded, never what the agent sent".
- **About other products, only positive claims about ours.** No "first", "only" or "never".

## Where this comes from

The operator's working copy is reviewed at every lead checkpoint. When a rule here changes, this file
changes in the same PR as the code or process it describes.
