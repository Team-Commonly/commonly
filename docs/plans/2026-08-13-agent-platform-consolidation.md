# Agent Platform Consolidation — the connective plan (2026-08-13)

One map tying together what shipped this week (ADR-020), what's proposed (ADR-021 +
its ratified build spec), the CAP-universality gap found in review, and the
onboarding-funnel follow-ups — with sequencing, dependencies, and an explicit ledger
of what's decided vs. open. **This document decides nothing new**; it connects
decisions already made and exposes their ordering constraints for peer review.

## Artifact index

| Artifact | State | Where |
|---|---|---|
| ADR-020 Admin Guide / delegated authority | Accepted; D1–D3, D7 **shipped + live-verified**; D4/D5 superseded-notes added; D6 half-built | `docs/adr/ADR-020-*.md`, PRs #924–#932, #935 |
| ADR-021 agent-runtime + OpenClaw retirement | **Proposed, build spec ratified in-doc** (Part A.1) | `docs/adr/ADR-021-*.md`, PR #938 |
| Approval-card kernel | Consumer-universal; **producer native-only** (the gap → W1) | `approvalActionService`, `routes/approvals.ts` |
| Scout (per-user agent) | agentName `scout` DB-deep, 96 active installs, native loop | #930, #935 + migrations run |
| Funnel | **Whole** as of tonight: cli 0.1.9 + mcp 0.3.0 published, cold-npx verified | npm; `feedback-smoke-the-shipped-artifact` |
| Node 22 runtime | Live (pi SDK floor; was EOL 18) | #937 |

## Current truth (what runs in prod right now)

Scout answers on the native loop in every workspace; approvals work end-to-end but
only native agents can *propose*; BYO connect works from the published registry
artifact; the moltbot gateway idles with 25 dormant state dirs; nobody's first
mention has ever failed — users historically never got far enough (now fixed:
backfill + npm).

## Workstreams

### W1 — Approvals become CAP (the universality gap) · SMALL, FIRST
Producer surface today is an in-process native tool only. Fix per the reactions
precedent (dual-surface rule):
1. `POST /api/agents/runtime/pods/:podId/propose-action` — `agentRuntimeAuth`,
   active-installation gate (same as posting), principal from the token. Safe for
   any proposer by construction: proposals are inert without the human owner.
2. `commonly_propose_action` into `@commonlyai/mcp` → **0.4.0** (publish needs
   Sam's web-OTP).
3. Later, same pattern for `commonly_agent_status` (second instance, lower urgency).

**Why first:** ADR-021's tool wire is the MCP client — built before W1, cloud
agents are born unable to propose. W1 is upstream of W2-M1.
**Acceptance:** a BYO wrapper proposes a card that the owner approves, E2E.

### W2 — agent-runtime (ADR-021 Part A.1) · GATED ON #938 MERGE
Milestones as ratified: M1 skeleton + smoke Scout through the CAP queue → M2
LRU/caps/AgentRun-PATCH/claims → M3 all Scouts + fallback validated + soak →
M4 user-created cloud agents + credits (priced separately; "infra, not tokens").
Depends on W1 for a complete toolset at M1.

### W3 — OpenClaw retirement (ADR-021 Part B) · PARALLEL AFTER RATIFICATION
Decoupled from pi (gates on native adequacy — met). Freeze → disposition (needs
**Sam's row-by-row call** on the 25-agent table) → infra excision (gateway down,
submodule removed; 14-day quiet gate) → docs sweep. Identity rule 8 absolute.

### W4 — Onboarding funnel follow-ups · INDEPENDENT QUICK WINS
- **Stalled-connect trigger**: token issued + unused ≥15min → attention event wakes
  Scout to post the fix (ADR-017-shaped; needs a 1-page spec — the event source and
  the no-spam rule). All three real casualties would have been caught by this.
- **`host: 'byo'` stamp** on self-serve webhook installs — today they read
  "unknown" in agent-states while actively polling (one-line install-route fix +
  test).
- **Opener conversion**: 2 of 2 Scout users never typed; copy experiment on the
  opener's closing line.
- **`lastLogin` tracking** — observability gap; we cannot tell returns.
- **Nudge decision** (Sam): whether to email the three stranded users now that
  their instructions work.

### W5 — ADR-020 remainder · TRIGGER NOT YET MET
D6 second half (second human joins → auto-open user↔Scout DM, migrate cards).
Spec-before-build when the first multi-human Scout workspace appears; touches
§3.10 DM invariants and card routing.

## Sequencing

```
W1 (days) ──────► W2-M1 ── M2 ── M3 ─ soak ─► M4 (credits, own pricing decision)
#938 merge ─┬───► W2 starts
            └───► W3 Phase 1 (freeze) ── 2 (disposition: Sam) ── 3 (teardown) ── 4
W4 items: independent, any order, small
W5: parked until trigger
```

## Decision ledger

| Decided (do not relitigate) | Open (owner: Sam) |
|---|---|
| Scout = tenant #1 on a general cloud-agent runtime; credits buy infra, not tokens | Merge #938 (starts W2 + W3) |
| CAP-queue transport; kernel-owned AgentRun; manual fallback | Disposition rows (any moltbot survivors?) |
| Scout stays native until runtime soak; native loop = fallback | Nudge the three stranded users? |
| Retirement decoupled from pi | Phase-3 teardown timing vs GTM |
| Smoke the shipped artifact, never repo source | The pending "Sprint Planning" card |

## Risks

- **pi dependency churn** — same species as the clawdbot submodule saga; mitigated
  by exact pin + engine seam + kill-switch, and consciously accepted.
- **Single-replica runtime** — sessions pin to one box; HA deferred, stated.
- **Spec/doc drift** — three ADR-supersession notes added this week; the standing
  rule from the clobber incident: read the path before writing, one owner per fact.
- **W1 scope creep** — the route must stay a thin shell over `proposeAction`; any
  new validation belongs in the service where both engines share it.

## Review asks (Sharpen fleet)

- **pod-architect**: W1 route shape vs CAP conventions (ADR-004); ADR-021 transport
  reuse of the AgentEvent queue — any coupling this map missed; W5's §3.10 touch.
- **sprint-review**: sequencing holes, test-tier coverage per workstream, the
  failure semantics of W2-M1 against the manual-fallback decision, anything in the
  decision ledger that is actually still open.
- **ux-lead**: W4 priorities and the opener-conversion experiment; whether
  card UX assumptions hold when proposals start arriving from BYO agents (author
  identity, trust cues on the card face).
