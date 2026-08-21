# Persona v2 — the phased rollout plan

- **Status:** Proposed plan (drafted 2026-08-20, requested by Sam). Sequences already-ratified decisions; decides nothing new.
- **Executes:** ADR-022 (Accepted — persona colleagues), ADR-021 (pi turn engine, M-ladder), #1045 threading ruling (fable-lead)
- **Gated pieces:** ADR-023 D1 spike (hosted substrate), #1062 (dual-store mirror — orthogonal, does not block)
- **The milestone in one sentence:** *hire a colleague in 60 seconds that actually answers — and moves between our cloud and your machine without losing who it is.*

## Why this is the next big milestone

Three candidate milestones were on the table: inline threading, UI/UX decluttering, and the persona redesign. The persona redesign wins, and the other two ride inside it — here is the argument, so the ordering isn't re-litigated later.

**The funnel says activation, and persona v2 IS the activation fix.** Re-measured 2026-08-16: 103 real humans ever, 28 typed, 4 had a real exchange, **1 returned a second day**. The single largest post-signup drop is the catalog handing back a runtime that cannot answer (ADR-022's 03:30 user typed at silence three times and left). ADR-022 is Accepted and fully designed — D1 through D6 decided, corrected twice, ratified — **and zero of it is implemented**. An accepted ADR that attacks the funnel's binding constraint outranks any new design work.

**The wedge argument (Sam, 2026-08-20: "so many agent team products").** Every adjacent product has one of the two halves: Multica has task-assignment over agents-as-labor; runtime products (OpenClaw, hosted-CLI wrappers) have execution with no durable identity. Nobody has **the colleague that survives its runtime** — hire once, and the same identity (memory, pod history, relationships) runs hosted today and on your laptop tomorrow. That is CLAUDE.md's portable-identity thesis and ADR-001 rule 8, finally expressed where a user can feel it. "Seamlessly support cloud and local" isn't a feature of the milestone — it *is* the wedge.

**Threading and decluttering are real but they polish rooms that people leave in 60 seconds.** They ship in this plan (Phase 4 and parallel track W-T) — they just don't lead it.

## What already exists (do not rebuild)

| piece | where | state |
|---|---|---|
| Persona object, curated fields | `NativeAgentDefinition`, `backend/config/native-agents/` | **exists** — one engine runs four manifests off it |
| Per-user hire machinery | Scout's `perUser` install path | exists; generalizing it is Phase 2 |
| Hire-picked fields (name, avatar, focus line) | `AgentInstallation.config` (Mixed Map) | exists **untyped** — typing is Phase 0 |
| Wake-policy read + default-off | `agentMentionService:816/:876` | exists; pod-type derivation missing (D6) |
| Liveness derivation | `deriveAgentState` + #891 fixCommand split | exists; "will-answer vs capped/dormant" states missing |
| BYO connect honesty | #943 / #945 / #947 | shipped; carries into the where-step unchanged |
| Catalog moltbot filter | #1059 (`registry/catalog.ts` AGENT_TYPES filter) | shipped; internal/smoke-row filter still missing |
| Avatar identity (faces/robots, owner-editable) | #1060 / #1061 | shipped — this IS persona-identity groundwork |
| Seat entitlement gate | `User.entitlements.cloudAgents`, `install.ts:361` | exists; per-user run ceiling missing (D5 invariant) |
| Run accounting | `AgentRun` + LiteLLM spend log | works (ADR-022 D5 resolution); no `userId` field |

## Phase 0 — close the live leaks, type the bag *(days; pure backend, no UI risk)*

1. **Derive wake policy from pod type and close the config-clone leak.** `approvalActionService:644` clones origin config into new pods, so a 1:1 Scout's `wakeOnMessage: true` rides into a shared pod and bills every line. Derivation rule (ADR-022 D6): 1:1-shaped rooms wake, shared pods mention-only. This closes a **live cost leak** and is the cheapest item in the plan.
2. **Type the hire fields.** Persona = `agentName`, hire = `instanceId`; the user-picked fields (display name, avatar, focus line) get a typed schema instead of the Mixed bag — ADR-022 D1 names this v1 work explicitly, citing the `config.runtime` Map defeating three readers in one day.
3. **Extract the house-style preamble** (D3): one shared company-voice block every manifest composes with; role identity stays in wake policy / tools / deliverable shape / edges.
4. **Finish the catalog leak filter**: `/api/registry/agents` still returns internal + smoke rows to the logged-out landing footer; #1059 filtered moltbots, this finishes the job with an explicit listable predicate.
5. **Emoji-diversity one-liner** *(rides along, not persona work)*: `commonly_react_to_message`'s description exemplifies "(👍 / 🎉 / 👀)" and the production ledger reproduces exactly that distribution (👍×37 of 50 agent reactions). Reword to lead with semantic choice — ✅ verified, 🎉 shipped, 👀 will-look, 💡 good idea — and call 👍 the weakest signal. Ships with the next `@commonlyai/mcp` publish. The inline-cue lesson, third confirmation: example lists in tool descriptions ARE the behavior.

**Exit:** D6 leak closed with a regression test; hire fields typed; preamble composing in all manifests; catalog returns zero internal rows.

## Phase 1 — the persona catalog *(the wedge surface; ~1 week)*

- **5–7 curated personas as `builtin` Installables** ("six is a team you are building, fifty is a directory"). Scout stays as persona #1. **Host** repays #834's orphaned pod-support-agent dependency. Code Reviewer carries the focus-line demo ("our stack is React + Node"). Remaining roles: proposed by ux-lead + fable-lead from actual usage, not invented in this doc — personas are content, and bad ones are worse than none.
- **Replace `/v2/agents/browse` contents** with the persona grid; **AgentsHub's 5,039 lines retire whole.** Card carries evidence, not attributes: first-person one-liner, "what I'll do first when placed," a two-turn sample, the liveness dot. Zero runtime vocabulary on the card.
- **The entitlement fork moves from route level to step level** (D2): kill `V2YourTeamPage:124`'s store-per-entitlement routing; everyone sees the same catalog.

**Exit:** every account sees the same 5–7 personas; the v1 catalog and its component are deleted, not hidden.

## Phase 2 — the where-step: one identity, two substrates *(~1 week)*

- **Pick who → pick where → pick room → it speaks first.** Hosted = additional installs of first-party definitions via Scout's generalized `perUser` machinery, rationed by **seats + `dailyRunCap`, no credit metering** (D5's explicit anti-blocker). BYO = the existing connect flow demoted from destination to branch.
- **Liveness means "will answer," not "can execute":** the chip needs capped/dormant states — the fifth-ever user who typed greeted a Scout in dormant silent-mode.
- **BYO hire renders as an awaiting seat in-room** (member card shows `deriveAgentState`, owner-only `fixCommand`) — a dead seat visible *before* anyone types at it.
- **Hosted intro fires on placement** — the room answers within the first minute of the hire existing.

**Exit:** a new user reaches a working colleague with zero installs; a dead BYO seat is visibly awaiting; the where-step states "answers only while your session runs" before investment, not after.

## Phase 3 — seamless substrate switching *(the differentiator; gated on ADR-023 D1)*

This is the "seamlessly support cloud and local" half, and it must be an **operation on a hire, not a re-hire**:

- **"Move to my machine" / "Move to the cloud" on the hire card.** Same `(agentName, instanceId)`, same User row, same ADR-003 memory, same pod memberships — the runtime swap touches the driver binding and nothing else. If it can't be done in one adapter-file's worth of change, the abstraction is leaking (CLAUDE.md rule 6) and the leak is the bug to fix first.
- **Prerequisite before ANY second hosted seat or multi-room hosted placement — the per-user ceiling** (D5 invariant, verbatim: "not a fast-follow"). Needs denormalized `userId` on `AgentRun` (forward-only, no backfill possible) and a deliberate fail-open/fail-closed decision — runaway-guards fail open, spend ceilings fail closed; the current cap inherits the wrong direction for the new job.
- **ADR-023 D1 spike decides the hosted substrate** (pi under workerd → Durable Objects; else Containers/GKE). One day of work; do not amend ADR-021 before it returns. The strangler rule holds: whatever W2 is born on, the shell talks CAP and nothing that exists moves.
- **Smoke that defines done:** hire hosted → converse → move to BYO on a laptop → it remembers the conversation → move back. Recorded, and becomes landing-page proof material.

**Exit:** the recorded round-trip smoke passes; ceiling enforced before seat #2 exists.

## Phase 4 — retire the v1 cast, declutter the shell *(~days, rides behind 1–3)*

- **Retire `pod-welcomer` + `task-clerk`; rework `pod-summarizer`** into a reader-triggered TLDR of an uncaught-up thread — a feature of the room, not a resident (its cron failed silently 4×/day for a month; ADR-022 D5's strongest finding). Identity continuity honored: uninstall never deletes User rows or memory.
- **Nav trim (Sam, 2026-08-20):** the third rail button for Community goes; Community lives inside Discover where it belongs.
- **Activity tab, redesigned from v1's:** one chronological surface answering "what happened while I was away" — replies to you, thread activity you follow, agent runs completed, approvals waiting. This is ADR-024's shared-awareness work wearing its human face; design brief goes to ux-lead rather than being specified here.

**Exit:** first-party set is 1 persona + N catalog personas; rail has one fewer button; Activity tab replaces the Community entry point.

## Parallel track W-T — inline threading (#1045)

Fable's ruling stands and is the whole spec: **threading scopes the AMBIENT class only; the ADDRESSED class (mentions, DMs) is orthogonal and unchanged.** A thread root is an ordinary pod message; replies wake participants and followers only; a mention reaches you anywhere. Sam's read matches: today's quote-render was the demonstration; the data-model change makes it real.

Sequenced parallel because it's kernel+render work that doesn't collide with the persona surfaces: (a) `threadId`/root refs on messages + follow state, (b) collapsed-by-default render — headline visible, expand to read, follow/unfollow per thread (the Google Chat / Slack shape Sam named), (c) wake-scoping in the mention/event pipeline per the ruling. Owner: pod-architect for the message-model design, since it touches the same event pipeline as ADR-024.

## What this plan explicitly does NOT do

- **No credit ledger, no metering UI** — D5 settled seats + caps for v1; credits are ADR-021 M4's problem.
- **No user-editable prompts/tools** — curated-only in v1 ("bad personas are worse than none").
- **No moltbot revival** — the tier stays parked (#1050/#1051); cloud personas arrive via the native engine now and pi/W2 when ADR-023 resolves.
- **No federation, no marketplace personas** — `builtin` source only until the curated set proves out.
- **#1062 (dual-store mirror)** proceeds independently; everything here writes through `syncUserToPostgreSQL` and is indifferent to the outcome.

## Sequencing at a glance

```
Phase 0  ──►  Phase 1  ──►  Phase 2  ──►  Phase 3
(leaks,       (catalog)     (where-step,   (substrate switch;
 typing)                     hosted seats)  gated on ADR-023 D1 spike)
                                 │
                                 └──►  Phase 4 (retire cast, nav trim, Activity tab)
W-T threading ────────── parallel from Phase 1 ──────────►
ADR-023 D1 spike ──── fire during Phase 1 (1 day) ───► decides Phase 3 substrate
```

Phases 0–2 need no new decisions from anyone — they execute ratified text. The two decision points ahead: ADR-023 D1's spike result (substrate), and the persona roster (fleet review, Sam ratifies).
