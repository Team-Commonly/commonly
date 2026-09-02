# ADR-020: The Admin Guide — harness embedding, delegated authority, and approval cards

**Status:** Accepted (design settled in founder grill 2026-08-13; ratified by Sam same night — "build them full")
**Deciders:** Sam (product), session grill 2026-08-13
**Relates to:** ADR-017 (this implements its card, v1), ADR-003 (identity keying — see the
2026-08-13 shared-envelope incident), ADR-001 (manifest carries the new fields), ADR-011
(scheduling), ADR-018 (claims/caps remain the Guide's safety envelope)

## Context

The Guide (retention plan D4, shipped #911) is a per-user native-runtime agent that makes a
new user's first minutes feel alive. Two pressures now converge on it:

1. **Product**: the Guide should act as the user's *admin* — set up agents, create pods,
   drive onboarding missions — not just answer questions. Actions that create surfaces other
   people can see need the user's consent, which means **interactive approval inside chat**.
2. **Runtime**: the Guide runs on a bespoke 630-line LLM loop with five hardcoded in-process
   tools — a third tool surface drifting from `@commonlyai/mcp`'s canonical set, exercising
   none of the paths our users depend on. The 2026-08-12 pi.dev evaluation (research +
   local spike) validated a proper harness: pi headless through LiteLLM's `deepseek-v4-flash`
   alias works, print-mode session resume works, and pi ships a first-class Node SDK
   (`createAgentSession`) that its docs recommend over subprocess spawning for Node apps.
   The community MCP CLI extension did NOT surface tools headless — the SDK path, where we
   register tools programmatically, is the reliable one.

A fact-check during the design grill also surfaced a live defect, fixed same-session
(#923): every Guide installed as `(guide, 'default')`, one identity instance-wide — and
ADR-003 keys the memory envelope by identity, so all users' Guides shared ONE memory doc.
Zero bytes had been written; prevention, not remediation. Per-user identity
(`instanceId = u<userId>`) is now a prerequisite this ADR builds on, not a decision it makes.

## Decisions

### D1 — Capability boundary: outward needs approval, contained is autonomous
The rule, not a list: **any action that creates or changes a surface other people can see or
join (create pod, send invite, install an agent) requires an approval card. Anything
contained in the user's own workspace (tasks, memory, reads, replies) stays autonomous.**
Billing, auth, and token operations are never available to the Guide regardless of approval.
New capabilities are classified by the rule at review time — the rule itself only changes by
amending this ADR.

### D2 — Delegated authority: agent identity executes, user authority owns
When an approved action creates a resource, the resource belongs to the **user** (e.g.
`Pod.createdBy = user`, Guide added as a member), the executing identity remains the
**Guide** (attribution stays honest — the as-operator incident rule), and the approval is
the **authorization record**: a persisted `AuthorizedAction` linking card → approving user →
agent identity → action + params → execution result. Today the kernel cannot express this at
all (an agent-created pod is owned by the bot, the human isn't even a member); the
`onBehalfOf` execution path is new kernel work and the heart of this ADR.

### D3 — The approval card IS ADR-017's card, implemented
No parallel primitive. v1 implements the ADR-017 lifecycle (`flagged → resolved / expired /
moot`) with its invariants intact: **only a human writes `resolved`; retiring a card is
never an approval; fail closed**. Concretely:
- Messages gain a real structured `payload` (Mongo + PG both). **Shipped (amended
  2026-09-01) — the parenthetical here used to read "today neither store has a metadata
  column and every card is a regex sentinel in the content string", and that is no longer
  true of either store.** `models/Message.ts` declares `MessageType` including `'card'`
  plus `payload` (`Schema.Types.Mixed`); `models/pg/Message.ts` carries `payload` as JSONB,
  written by the INSERT and rewritten on status transitions by `updatePayload`. The posting
  half is live too: `approvalActionService.ts` posts `messageType: 'card'` with
  `buildCardPayload(row)`, and `resolveApproval` does the authenticated resolve and stamps
  `decidedAfterExpiry`. **What is NOT built is the chat renderer this bullet implies**:
  `V2MessageBubble` branches on message type exactly once, for `'image'`, so a card lands in
  a pod as the plain-text `content` fallback `approvalActionService` sets beside the payload
  — invisible rather than broken. Scope work off the code, not off this bullet's old tense.
  (Beware `v2/utils/threadView.ts`'s `kind: 'card'` — an unrelated thread rollup with its
  own tests, not this card.)
- Cards are actionable by the workspace owner only; execution is idempotent (a card executes
  at most once — double-taps and concurrent resolves lose cleanly with honest copy).
- **Expiry is advisory age, not refusal** (amended 2026-08-13, fleet review): per
  ADR-017:201 an expired card stays *decidable* — refusing a late decision would convert
  fail-closed into fail-silent, dropping the owner's explicit intent because a timer won.
  The card renders an age warning beside live owner controls; a late decision is honored
  and stamped `decidedAfterExpiry` on the audit record. This ADR's original
  approve-after-expiry-is-a-no-op wording contradicted the ADR it implements — caught by
  pod-architect reviewing the first kernel PR.
- Interaction follows the proven reaction-chip pattern: click → authenticated POST →
  server-state change → socket fanout.
- `agent.ask` (agent→agent, CLI-only) is unchanged; its shape informed the design and its
  human-facing gap is closed by this card, not by extending it.

### D4 — Runtime: backend stays the scheduler, pi SDK becomes the turn engine

> **SUPERSEDED by ADR-021 (2026-08-13).** Scout keeps the native loop, which proved
> adequate for its stateless-turn job; pi became the **general cloud-agent runtime**
> (`agent-runtime` service — CAP-queue transport, persistent per-agent sessions,
> MCP-contract tools). The in-process-session design below is preserved in ADR-021's
> appendix as the deferred path if Scout's job ever outgrows the loop. Do not build
> from this section.
The event path (wake-on-message → claim → daily cap → `AgentRun` accounting) is untouched.
The bespoke chat/completions loop is replaced by an embedded, **version-pinned** pi
`AgentSession` per run: in-process, no reserved capacity, no per-user pollers ("slots"
dissolve into the per-user Installable row that already exists plus a per-workspace session
file). Tools are registered programmatically and are exactly the commonly tool contracts —
bound per-run to the workspace's scoped credentials, never a global service credential.
Model routing stays LiteLLM (`deepseek-v4-flash` alias), keeping keys, quotas, guardrails,
and observability on the single surface.

### D5 — Isolation: logical tier now, process tier as a manifest flag

> **Amended 2026-08-13:** tier (a) shipped as written. The tier-(b) process flag was
> never built here and is **absorbed by ADR-021's agent-runtime** (service-level
> separation now; worker-process pool as that track's named follow-up). This section's
> trigger condition still stands and now routes to ADR-021.
Tier (a) — per-user identity (#923), per-workspace session files, per-run scoped
credentials, a per-user concurrency semaphore, and the daily run cap — is the default. The
agent manifest gains an isolation field so any single agent can be flipped to tier (b),
spawn-as-OS-process, by config. The trigger for revisiting the default is scope expansion:
an admin-capable agent operating anywhere beyond a single-human workspace.

### D6 — Home surface: My Workspace while single-human; DM on second human
The Guide's home stays My Workspace — its working materials (board, starter missions, the
user's BYO agent) live there, and a single-human workspace is already 1:1-shaped. The moment
a workspace gains a second human, the kernel auto-opens the user↔Guide `agent-room` DM and
**approval cards migrate there** — owner-only decisions don't belong in a room teammates
read. Admin powers never fire from shared pods (D1 surfaces + prompt-injection scope).

> **Scope boundary — read before implementing against this decision.** D6 governs where
> the *Guide's admin authority* and *approval cards* live. It says nothing about whether
> ordinary agents may respond without being mentioned; **that is ADR-018 D8**
> (wake-on-message is a per-install setting, "a setting, not a ratchet", and claims are
> what make a busy room safe — all wake, one acts).
>
> Note also that "1:1-shaped" here counts **humans**, not members: a workspace with one
> human and several agents is still single-human.
>
> This note exists because PR #963 read D6 as the governing rule for wake policy, gated
> wake-on-message on `members.length <= 2`, and demoted every multi-agent workspace to
> mention-only in production. ADR-018 was the governing document but sat at Proposed
> while this one was Accepted. Fixed in #967; ADR-018 ratified in #968.

### D7 — First slice (agile order)
One end-to-end line, forcing each primitive into existence minimally: message `payload`
column → ADR-017 card render → approve action → Guide executes `create_pod` with
`onBehalfOf` → the user owns the pod. Scheduled after onboarding-mission kernel
verification, before the device-flow connect work. The pi-SDK engine swap ships behind a
flag in the same window (no behavior change on its own).

## Non-goals (now)
Roaming admin powers in shared pods; a credits economy attached to missions (the mission
reward is a hosted-agent unlock via the existing invite gate); container isolation by
default; retiring the v1 `agent.ask`; migrating any agent other than the Guide onto the
embedded harness before the pilot criteria in the cloud-agent track are met.

## Consequences
- Two new kernel primitives (structured message payload; `AuthorizedAction`/`onBehalfOf`)
  and one implemented ADR (017) — each with a second consumer already visible (mission
  unlocks, BYO confirmations, ADR-019 handshakes).
- A third-party harness enters the backend's dependency surface: pinned version, MIT,
  Node ≥22.19 (backend image constraint to verify at implementation), releases every few
  days — upgrades are deliberate, tested events.
- The Guide becomes the standing production test of the commonly tool contracts.
