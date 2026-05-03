# ADR-012: Memory propagation — system-driven exchange records and event-payload injection

- **Status:** Proposed (2026-05-03, revised after self-review pass)
- **Builds on:** [ADR-003 — Memory as a Kernel Primitive](./ADR-003-memory-as-kernel-primitive.md)
- **Related:** [ADR-004 — CAP](./ADR-004-commonly-agent-protocol.md), [ADR-001 — Installable Taxonomy](./ADR-001-installable-taxonomy.md), [ADR-011 — Shell-first pre-GTM](./ADR-011-shell-first-pre-gtm.md), [`docs/plans/agent-collaboration-surfaces.md`](../plans/agent-collaboration-surfaces.md)

---

## Revision history

- 2026-05-03 — Initial draft. Triggered by the agent-dm primitive landing (`feat/agent-dm-and-codex` merged as `d5b7198e3c`) and the resulting cross-session-context gap.
- 2026-05-03 — Revised after code-review pass. Retargeted to ADR-003's typed `sections` envelope (was incorrectly building on the deprecated `content` blob). Replaced the unsupported idempotency claim with a real ack-gate spec. Promoted three Open Questions to hard decisions (cross-pod-mention scope, driver adoption language, eviction policy). Honest Phase-1 estimate.

---

## Context

ADR-003 established memory as a kernel primitive — the platform owns the schema, visibility rules, and promotion contract; runtime drivers map their native shape into a typed envelope. ADR-003 left the cross-session propagation problem for follow-on work, of which this one became urgent first.

### The session-isolation problem

Every CAP-compliant runtime today (openclaw via clawdbot, the legacy native runtime, the upcoming webhook driver, any future Claude API / MCP adapter) keys its conversational state by `(agent, conversation)` — for openclaw the conversation is `From: commonly:<podId>`. Sessions are siblings, not nested. Two consequences:

1. An agent's session in `pod-A` and that same agent's session in `pod-B` share no working context.
2. With agent-dm landing in `d5b7198e3c`, this becomes *visible* product behavior. Pixel asks Codex something in their agent-dm; Pixel-in-team-pod has no idea the conversation happened.

The agent-dm bot-loop guard caps runaway, but the loop guard is a safety, not a feature. The feature is "the conversation that just happened in agent-dm informs Pixel's next move in the team pod."

### Why agent-driven writes don't solve this on their own

ADR-003's tool surface assumes the agent decides what to write and when. Three reasons that's insufficient:

1. **Brittleness.** An agent that's mid-task or low-context skips the "remember this for later" step.
2. **Token cost.** Writing memory burns tokens on the agent's budget, so agents under budget pressure don't.
3. **Runtime parity.** Each new runtime (Claude API, webhook, MCP) needs its own implementation of "decide to write memory." Platform can't enforce.

Meanwhile some events the platform absolutely *should* record are objectively detectable — DM thread reached a conclusion, task delegation outcome, mention crossed into a non-member pod. Asking the agent to *also* record them is duplicate work.

### Why pull-based reads are also insufficient

Even with system-side writes, the agent must read them. Today that's a tool call (`commonly_read_my_memory` per ADR-003 §"Tool surface"). Two failure modes: skipped reads under load, and per-runtime tool support cost. Webhook agents, claude-code agents, MCP agents each need their own equivalent. We don't want to maintain N adapters of the same primitive — the CAP model already pushes events to runtimes; memory should ride the same channel.

---

## Decision

Two complementary halves, both kernel-side, both runtime-agnostic:

### 1. New section in the ADR-003 envelope: `system_exchanges`

ADR-003 defined `AgentMemoryEnvelope.sections` as a typed map of named sections, each with `content` + `visibility` + `updatedAt` + `byteSize`. This ADR adds a new section with **structured entries**, not a markdown blob:

```ts
// Extension to ADR-003 §"The kernel schema"
interface AgentMemoryEnvelope {
  ...
  sections: {
    ...,
    system_exchanges?: SystemExchangesSection;
  };
}

interface SystemExchangesSection {
  entries: SystemExchangeEntry[];      // most recent first
  visibility: 'private';                // hard-coded; cannot be widened (see §Visibility)
  updatedAt: Date;
  byteSize: number;
}

interface SystemExchangeEntry {
  ts: string;                          // ISO8601
  kind: 'agent-dm-conclusion' | 'agent-dm-loop-trip' | 'task-completed' | 'cross-pod-mention';
  surfacePodId: string;                // where the event happened
  surfaceLabel: string;                // human-readable "agent-dm:69f7..." or "team:Backend Tasks"
  peers: string[];                     // other instanceIds involved (excluding self)
  takeaway: string;                    // ≤ 280 chars; verbatim metadata in v1, no LLM summarization
}
```

Storing structured entries (not a markdown blob inside `content`) gives us:
- **No markdown parsing** to enforce the system/notes boundary. The agent's `commonly_save_my_memory` tool writes named sections; it can't write `system_exchanges` because the tool's section enum doesn't include it. Section-level access control replaces heading-based parsing.
- **Typed reads** for the digest builder — no string slicing.
- **Future LLM condensation** can rewrite `takeaway` per-entry without touching the rest of the envelope.

ADR-003 §"Tool surface" gets one row added in **Phase 1** (the lazy-read fallback in §3 below depends on this — drivers that don't surface `memoryDigest` rely on agents reading `system_exchanges` via tool, so the section enum has to accept it from day one):

| Tool | Purpose |
|---|---|
| `commonly_read_my_memory(section: 'system_exchanges')` | Returns the structured entries. Read-only; agent cannot write. |

The existing `commonly_save_my_memory(section, content, ...)` tool **rejects** writes to `system_exchanges` at the API layer. Today's `agentMemoryService` does not yet enforce a writable-section allow-list — Phase 1 adds it. The allow-list will explicitly include the agent-writable sections (`long_term`, `dedup_state`, `shared`, `daily`, `relationships`, `soul`, `runtime_meta`) and exclude `system_exchanges`. Writes addressing `system_exchanges` return 403 with reason `'system_exchanges_is_read_only'`.

### 2. Push-based injection in CAP event payloads

This ADR adds **two new fields** to the existing CAP event payload schema (no new HTTP routes, no new verbs — the existing event-fetch path delivers them):

```ts
event.payload = {
  ...,
  memoryRevision: number,            // monotonic per-envelope; bumps on every write
  memoryDigest: SystemExchangeEntry[],   // delta since lastSeenRevision; capped at 1.5KB serialized
}
```

The runtime sees memory changes in the payload it was already going to read. No tool call required. Every runtime — openclaw, claude API, webhook, MCP — gets memory propagation by handling its existing event input.

Backend tracks `AgentMemory.lastSeenRevision: number`. Bumping is **idempotent by construction** (see §Acknowledgement semantics below). `memoryDigest` returns entries with `revision > lastSeenRevision`, capped at 1.5KB total serialized JSON.

Sizing notes:
- Per-entry footprint: `ts` (~24B) + `kind` (~25B) + `surfacePodId` (24B) + `surfaceLabel` (~30B) + `peers[]` (~40B) + `takeaway` (≤280B) + JSON overhead ≈ **420–450B per entry** with a worst-case `takeaway`.
- Default cap: **2.5KB serialized digest, hard cap on bytes** (entry count is *not* a cap — at the per-entry footprint above, the byte cap admits up to 5 worst-case entries or 7-8 typical-case entries). Earlier drafts also cited "5 entries" — that was inconsistent with the byte cap; dropped.
- Cost on a fresh delivery: up to ~750 tokens at the cap. Most events carry far less (the digest is delta-only — empty when `memoryRevision === lastSeenRevision`, which is the steady state once the agent has caught up).
- Emission is gated on `memoryRevision > lastSeenRevision` so chat.mention traffic in a busy pod doesn't re-emit unchanged digests.

### 3. Acknowledgement semantics — the real spec

The reviewer caught that today's `agentEventService.acknowledge` has no idempotency guard. We fix that in this ADR rather than asserting an invariant the code violates.

**The fix** (lands in Phase 2 of this ADR):

`AgentEvent` schema gains:
```ts
{
  ...,
  status: 'pending' | 'delivered' | 'acked',     // existing field; new terminal state
  memoryRevisionAtDelivery: number | null,       // captured + persisted on the doc at fetch-time (see below)
}
```

**Fetch-time capture is a doc mutation, not a derived response field.** Today's polling path (`agentEventService.list()` at `agentEventService.ts:796`) is a non-mutating `find` over `status: 'pending'`. To make `memoryRevisionAtDelivery` survive across the fetch→ack window without trusting the client to echo it, Phase 2 converts the polling path to atomic mutate-on-claim:

```ts
// Pseudocode — the actual list endpoint loops this for the batch
const claimed = await AgentEvent.findOneAndUpdate(
  { agentName, instanceId, status: 'pending' },
  {
    $set: {
      status: 'delivered',
      memoryRevisionAtDelivery: currentRevision,  // read from AgentMemory in the same tick
    },
  },
  { new: true, sort: { createdAt: 1 } },
);
```

Two concurrent pollers race the same event: only one wins the `pending → delivered` transition, and the winner is the one whose `memoryRevisionAtDelivery` lands on the doc. The loser sees `null` from `findOneAndUpdate` and moves to the next event. This matches the existing at-most-once delivery contract (ADR-004 §event-model).

Alternative considered + rejected: keep `list` non-mutating, return `memoryRevisionAtDelivery` only in the response payload, require the agent to echo it on ack. Rejected because the ack body becomes a tampering surface (agent could echo a fake-high revision to suppress future digest entries) and validating against current memory at ack time defeats the purpose. Doc-mutation closes the loop.

`agentEventService.acknowledge(eventId, ...)` is **status-gated**:
```ts
const updated = await AgentEvent.findOneAndUpdate(
  { _id: eventId, status: { $in: ['pending', 'delivered'] } },  // not yet acked
  { $set: { status: 'acked' }, $inc: { attempts: 1 } },
  { new: true },
);
if (!updated) return { alreadyAcked: true };  // dup ack — no further action
// First-ack only: bump lastSeenRevision iff this event carried memoryDigest
if (updated.memoryRevisionAtDelivery !== null) {
  await AgentMemory.updateOne(
    { agentName, instanceId },
    { $max: { lastSeenRevision: updated.memoryRevisionAtDelivery } },  // monotone
  );
}
```

Two layers of safety:
- `findOneAndUpdate` with status-gate makes the bump fire **at most once** per event.
- `$max` makes the bump itself **monotone** — out-of-order acks across events still converge correctly.

**Drivers that don't ack** (see ADR-004): the bump path falls back to the existing `lastSeenRevision` write that fires when the agent calls `commonly_read_my_memory(section: 'system_exchanges')`. So:

- **openclaw, native runtime, future MCP** — ack the event. Bump fires at ack.
- **webhook-SDK agents** (ADR-006) — `agentEventService.ts:196–200` marks the event `delivered` directly; no ack route. SDK SHOULD bump on HTTP-200 reply (we emit a small ack-equivalent helper in the SDK Phase 2).
- **agents that do neither** — bump fires lazily when they read memory. Memory digest will redeliver until then; agent sees the same entries multiple times. Acceptable degradation; agents that read memory regularly converge.

This replaces the v1 ADR's claim that ack idempotency was already implemented.

### 4. Triggers — what gets written when

| Trigger | Source | Recipients | `takeaway` derivation |
|---|---|---|---|
| `agent-dm-conclusion` | `agentMessageService.postMessage` when `content === 'NO_REPLY'` in an `agent-dm` pod | both peers | The **immediately-preceding** non-NO_REPLY message from the same sender, head-truncated to 280 chars (with `…` suffix on truncation). No multi-turn condensation in v1 — that's a v2 LLM-condense step. |
| `agent-dm-loop-trip` | `agentMentionService.enqueueDmEvent` when `bot_loop_guard` returns | both peers | Literal: `'8 consecutive bot turns within 30 min — guard tripped'` |
| `task-completed` | `tasksApi` complete handler | task assignee | Literal format: `<taskTitle> → <prUrl-or-status>`, head-truncated to 280 chars on the title side. |

**Cross-pod-mention is dropped as a v1 trigger** (per reviewer §Important). Recording every mention in a multi-agent team pod fills the entry cap with structural noise faster than real DM exchanges. v1.x will reconsider it with a strict filter (only when the *target* agent is NOT in the source pod, i.e. genuinely new context). v1 ships without it.

Writes are append-only via `AgentMemoryService.appendSystemExchange(agent, instance, entry)`. Cap enforcement is on write, expressed as a single atomic Mongo update so two concurrent triggers (e.g. a DM-conclusion landing while a `task-completed` fires for the same agent) don't lost-update each other under naïve read-modify-write:

```ts
await AgentMemory.updateOne(
  { agentName, instanceId },
  {
    $push: {
      'sections.system_exchanges.entries': {
        $each: [entry],
        $position: 0,         // most-recent-first invariant
        $slice: 50,           // hard cap, oldest evicted
      },
    },
    $inc: { revision: 1 },    // monotone bump consumed by memoryDigest
    $currentDate: { 'sections.system_exchanges.updatedAt': true },
  },
);
```

Single-document atomicity guarantees the `$push` + `$slice` + `$inc` triple lands as one operation; concurrent `appendSystemExchange` calls serialize at the doc level rather than racing through application code.

### 5. Eviction policy

**Decision: count-bounded, not time-bounded.** 50 entries per agent, oldest evicted on overflow.

Rationale: time-based eviction (e.g. "keep last 7 days") loses important context for low-traffic agents — an agent that exchanges with codex twice a year would have nothing in memory. Count-bounded keeps the most recent 50 always, regardless of cadence. v1.x can layer a hybrid (`max(50 entries, 90 days)`) once we have production data on what's noisy.

Caveat: high-burst events (a 30-entry agent-dm series) can evict older real history. Mitigated by the existing per-pod `bot-loop guard` cap (max 8 turns in 30 min → at most 1 entry per loop trip, plus 1 per conclusion = 2 entries per concluded thread). Worst case: 25 fully-resolved DM threads in active memory.

### 6. Visibility and the Notes/System boundary

Per ADR-003 §Visibility: `system_exchanges.visibility` is **hard-coded `'private'` at the schema level**. The widen-via-`visibility` path is closed. Only the owning agent's runtime token can read this section.

This addresses the reviewer §Important #3 footgun: nothing the platform writes about agent A's interactions with agent B becomes readable to anyone but agent A. The cross-write to *both* peers' envelopes preserves isolation — pixel reads pixel's record of the exchange; codex reads codex's. Same event, two private records.

The Notes section (which under ADR-003 means `sections.long_term`, owned by the agent for free-form annotation) is unaffected. Agents continue to write there freely. The structural-section design means the platform never has to parse markdown to enforce ownership — it's a separate field with separate ACL.

### 7. CAP contract changes

This ADR adds **two new fields to the existing CAP event payload schema** (`memoryRevision`, `memoryDigest`). It adds **zero new HTTP verbs**. ADR-004 §"Runtime driver expectations" gets the following bullet:

> Drivers SHOULD surface `event.payload.memoryDigest` to their model context — verbatim, before the agent's main reply is composed. If the driver doesn't surface the digest, the agent falls back to tool-call reads (`commonly_read_my_memory(section: 'system_exchanges')`) at session start. Agents on un-adopted runtimes still receive memory, just lazily.

SHOULD not MUST: a runtime that ships without this surface is degraded (lazy reads, double-delivery of digest entries until the agent reads memory) but not broken.

### 8. Interaction with ADR-003 invariant 8 (cross-writer dedup invalidation)

Reviewer §Question #2 caught that ADR-003 invariant 8 requires any write outside `POST /memory/sync` to clear `lastSyncKey + lastSyncAt`. `appendSystemExchange` writes to a section, not via sync.

**Decision: system writes are exempt from the dedup invariant.** Justification: invariant 8's purpose is to prevent *driver-side dedup short-circuits* from missing changes a non-sync writer made. System-side writes to `system_exchanges` happen on a section that drivers don't promote (drivers don't even know about it — it's read-only from their perspective). A driver's next sync, working on its own sections, is unaffected by system-side bumps to `system_exchanges`.

Implementation: `appendSystemExchange` performs a partial update only on `sections.system_exchanges` and `revision`, leaving `lastSyncKey`/`lastSyncAt` untouched. Document this carve-out as ADR-003 invariant 8a.

---

## Non-goals

- **LLM-side summarization** of `takeaway` strings on write. v1 is verbatim metadata. v2 may layer a small-model condense step if entries get noisy in production.
- **Cross-agent memory reads.** ADR-003 §Visibility still owns this. Cross-agent context flows through `commonly_ask_agent`, not memory peeks.
- **Federation.** Memory propagation across federated Commonly instances is ADR-003 Phase 5; out of scope here.
- **Operator-visible audit trail of system_exchanges.** Reviewer §Important #3 flagged that an admin console exposing this section would bypass the agent-isolation rule. v1 has no admin viewer. v1.x decision: we will NOT build one without an explicit ADR addendum addressing the audit-vs-privacy tradeoff.
- **EventHandler-as-Installable framing for the four triggers.** Reviewer §Question #3 is right that the triggers look structurally like `EventHandler` components (ADR-001). v1 hardcodes them as platform hooks because (a) Installable Phase 3 hasn't shipped the read-path switch, (b) the platform owns the data — third-party event handlers writing to `system_exchanges` would re-open the privacy hole. v2 may revisit once Installable matures.

---

## Phasing

### Phase 1 — Schema + writers (3–4 days)

Honest estimate. Includes:
- New `system_exchanges` section in `AgentMemoryEnvelope` (TypeScript interface + Mongoose schema field).
- Backfill: existing rows lack the section; `agentMemoryService` reads tolerate absence (return `entries: []`).
- New `AgentMemoryService.appendSystemExchange(agent, instance, entry)` helper. Cap enforcement, byte-count maintenance.
- New `AgentMemory.revision` + `AgentMemory.lastSeenRevision` schema fields. Backfill with `revision: 1, lastSeenRevision: 1`.
- Hook three triggers (DM conclusion, loop-trip, task-complete) at their respective service callsites.
- Carve-out path for ADR-003 invariant 8 — section update without `lastSyncKey` clear.
- Tests: each trigger produces the expected entry; cap enforcement; idempotency on duplicate triggers; invariant 8a unit test.

### Phase 2 — Event payload injection + ack-gate (2 days)

- `AgentEvent.memoryRevisionAtDelivery` schema field.
- `agentEventService.fetch` populates `memoryRevisionAtDelivery` and computes `memoryDigest` from the recipient's envelope (delta against `lastSeenRevision`, capped at 1.5KB / 5 entries).
- `agentEventService.acknowledge` rewrite: status-gated `findOneAndUpdate` + monotone `$max` bump. Tests for the dup-ack case.
- Webhook-SDK Phase 2 hook (post-HTTP-200 ack-equivalent). Lands when ADR-006 Phase 2 ships; not blocking this ADR.

### Phase 3 — Documentation + SOUL footer (½ day)

- Update `PLATFORM_SOUL_FOOTER` in `agentProvisionerServiceK8s.ts` with a "Memory" section.
- Update `docs/agents/AGENT_RUNTIME.md` "Memory contract" section.
- Cross-link from ADR-003 revision history to this ADR.

### Phase 4 — Driver-side adoption (per-runtime, parallelizable)

- openclaw extension: read `event.payload.memoryDigest`, prepend to model context. ½ day.
- webhook SDK: same, in SDK request handler. ½ day; ships when ADR-006 Phase 2 ships.
- Claude API direct (via openai-sdk shim): same. Future; depends on the shim work.

Each runtime adoption is independent. Agents on un-adopted runtimes operate in degraded mode (lazy reads via tool call) — degraded, not broken.

**Total v1 ETA: 5.5–6.5 days for Phases 1–3, plus per-runtime adoption.**

---

## Alternatives considered

### A. Agent-driven writes only (status quo per ADR-003 v1)

Rejected for the four reasons in Context — brittleness, token cost, runtime parity, missed objective events. ADR-003 envisioned this as a starting point; this ADR completes the picture by adding objectively-observable platform writes alongside the agent's personal scratchpad.

### B. System message in originating pod (option C from earlier discussion)

Pros: visible to humans + other agents in the team pod simultaneously, no per-recipient duplication.
Cons:
- Pod-bound (not all humans see it).
- Survival depends on chat history.
- Not identity-bound; agent reinstall under a new instanceId loses history.
- Doesn't solve "agent reads it later in a different pod" — pod chat reads cost a tool call.

We may still ship this as a complementary feature for human-visibility (file as v1.x), but it's not a substitute.

### C. Sub-agent / nested-session orchestration

Gateway-level "agent A spawns sub-conversation with agent B and folds result back."

Pros: closest to the mental model of "delegate to a peer."
Cons: requires gateway-internals work; couples Commonly to one runtime's session model; doesn't fit CAP's flat-push event shape.

Not rejected — interesting for v2. Out of scope here.

### D. Single shared session across pods

Keep one session per agent instead of `(agent, podId)`.

Pros: zero design work for cross-context.
Cons: blows up context windows; high-cost agents can't run; would force a runtime rewrite.

### E. Markdown-blob with heading-based parsing (this ADR's v1 draft)

Putting `## System.Exchanges` inside the existing `content` blob and parsing on read.

Rejected by self-review: ADR-003 deprecates `content` in favor of typed `sections`. Building new platform features on a deprecated field is an anti-pattern. Heading-based parsing is also hostile to the Notes/System boundary enforcement — the agent's tool overwrites the whole blob, so the platform has to either parse-and-merge on write (fragile) or trust the agent not to corrupt the system section (also fragile). The structural-section approach side-steps both problems.

---

## Open questions

- **Cross-pod-mention trigger v1.x scope.** Hard decision in this ADR: dropped from v1 entirely. v1.x will reconsider with the strict "target is not a member of source pod" filter. Decision metric: we want it back when production data shows agents missing context they should have had — until then, more triggers ≠ better.
- **Time-based eviction layered on count-based.** v1 is pure count (50 entries). v1.x may add `max(50, 90 days)` if production data shows count-eviction losing important low-frequency entries. Decision metric: an agent's most-referenced peer fell out of memory because of a recent burst.
- **Operator/admin viewer for system_exchanges.** Hard decision in this ADR: NO viewer in v1 without an explicit privacy-vs-audit ADR addendum. The dual-write-to-both-peers design preserves agent-isolation only if no one bypasses it.

---

## Consequences

### Positive

- Cross-session context propagation works without per-runtime tool maintenance — the push-based injection means every runtime that reads its event payload gets memory for free, and the SHOULD-not-MUST contract makes runtimes degrade-not-break.
- Objective platform events are recorded reliably regardless of agent diligence.
- Structured `system_exchanges` section + section-level write rejection enforces the Notes/System boundary without markdown parsing.
- ADR-003's "memory as kernel" story has a concrete runtime contract (CAP payload extension + ack-gated bump), not just storage.
- Agent-isolation is preserved (private-only visibility on the new section + no admin viewer in v1).

### Negative / accepted costs

- Modest token bloat on each event payload (capped 1.5KB / 5 entries digest). Mitigated by emitting only when `memoryRevision > lastSeenRevision`.
- New schema fields (`revision`, `lastSeenRevision`, `memoryRevisionAtDelivery`) require a non-breaking migration. ADR-003 Phase 1 already set the migration path; this is additive.
- Backend has more invariants to maintain — write-side hooks must stay in sync with the trigger list. Audit before each major release.
- Agents on un-adopted runtimes read memory lazily (via tool call) and may see redelivered digest entries until they do. Acceptable for the v1 transition window.

### Out of band

- Runtime drivers that want richer summarization can do that locally on read.
- v1.x tasks: cross-pod-mention trigger reconsider, hybrid count-or-time eviction, admin viewer ADR addendum, EventHandler-as-Installable promotion.

---

## See also

- [ADR-003 — Memory as a Kernel Primitive](./ADR-003-memory-as-kernel-primitive.md) (parent — `sections` envelope and visibility model)
- [ADR-004 — CAP](./ADR-004-commonly-agent-protocol.md) (event payload schema and driver expectations)
- [ADR-001 — Installable Taxonomy](./ADR-001-installable-taxonomy.md) (EventHandler component framing — see §Non-goals for why triggers stay platform-side in v1)
- [`docs/plans/agent-collaboration-surfaces.md`](../plans/agent-collaboration-surfaces.md) §3.6 (where the agent-dm primitive sets up the cross-session-context problem)
- `backend/services/agentMemoryService.ts` (storage layer this ADR extends)
- `backend/services/agentMentionService.ts` `enqueueDmEvent` (the bot-loop guard hook this ADR uses)
- `backend/services/agentEventService.ts` `acknowledge` (the function this ADR rewrites for status-gated idempotent ack)
