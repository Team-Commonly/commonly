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
*(Amended after fleet review 2026-08-13 — pod-architect blocker + ux-lead UX half.)*
Producer surface today is an in-process native tool only. Order within W1:
0. **FIRST COMMIT — fix the decider derivation** (pod-architect, BLOCKING,
   measured & independently reproduced: 63/261 prod pods are bot-created).
   `ownerUserId = pod.createdBy` + the human-only rule makes cards in those
   pods undecidable by construction. Fix in the SERVICE: derive the decider
   from the accountable human (`AgentInstallation.installedBy` when human;
   REFUSE to mint when no human decider resolves — refusal is honest, an
   undecidable card is the exact failure this line exists to prevent). The
   same fix pre-solves W5's multi-human case, and the WAITING face must never
   render for an impossible owner (ux-lead: fails-silent on a consent surface).
1. `POST /api/agents/runtime/pods/:podId/propose-action` — `agentRuntimeAuth`
   **+ `phase4RateLimit`** (sibling mutating-route convention; propose is more
   expensive than post), active-installation gate, principal from the token.
2. **The UX half ships WITH the route, before 0.4.0** (ux-lead): origin cue
   mapped to **ADR-001's `source` axis** (first-party quiet; BYO renders
   "connected by @<installer>") + the **server-derived structured action**
   (actionType + key params — already on the wire in `buildCardPayload`,
   currently unrendered) as the PRIMARY consent line, proposer prose demoted
   to pitch. "Inert without the owner" covers execution, not mislabeling.
   **Round-2 upgrade (sprint-review, verified at source): the mislabeling gap
   is LIVE today, not BYO-only** — summary is caller-supplied (empty-reject +
   500-truncate is the entire validation) and renders as the headline, while
   Scout runs on injectable workspace input. Frontend-only fix (pod-architect:
   params/actionType already on the wire) — it does not block the route and
   may land ahead of it.
2b. **Decider lifecycle (round 2, ux-lead + pod-architect):** membership churn
   recreates undecidability regardless of derivation — nothing cascades pod
   membership onto ApprovalAction, so an owner leaving strands cards. Three
   agreed semantics: (i) an explicit **empty-decider face** (attention tone,
   names the fix) — needed regardless; (ii) per-viewer decidability computes
   in the **GET pending route** (per-caller), NEVER broadcast in CardPayload
   (the reaction-`mine` lesson, already inscribed in that file); (iii)
   decide-time re-derivation **widens** as well as repairs (a later-joining
   human becomes decider) — allow and **stamp the audit row** (the
   `decidedAfterExpiry` precedent), don't refuse.
3. `commonly_propose_action` into `@commonlyai/mcp` → **0.4.0** — publish is a
   **Sam-only web-OTP step on the W2 critical path** (moved to the Open ledger).
4. Later, same pattern for `commonly_agent_status`.

**Why first:** ADR-021's tool wire is the MCP client — built before W1, cloud
agents are born unable to propose. W1 is upstream of W2-M1.
**Acceptance:** a BYO wrapper proposes **through the PUBLISHED MCP package**
(sprint-review: an HTTP-only E2E passes while the npm tool is unpublished —
the exact artifact-vs-source class the smoke rule exists for); the owner
approves; **the card visibly attributes origin and renders the server's
parse**; pinned by a `reactionController.test.js`-shaped service-tier suite
(dual-auth + install gate + decider derivation incl. bot-created-pod refusal).
Remedy verified on all four installedBy write paths (sprint-review).

### W2 — agent-runtime (ADR-021 Part A.1) · GATED ON #938 MERGE
Milestones amended after review: **M1 = skeleton + smoke Scout + the CLAIMS
protocol** (pod-architect: delivered events requeue at 10min up to 3× — claims
one milestone downstream of that hazard is one engine interleaving itself) →
M2 LRU/caps/AgentRun-PATCH → M3 all Scouts + fallback validated + soak → M4
user-created agents + credits. Depends on W1 for the toolset **and the 0.4.0
publish (Sam's OTP, critical path)**. Failure semantics are now DEFINED in
#938 (trigger/mechanism/owner/granularity) — no longer decided in name only.
Named migration traps (sprint-review + follow-up):
- Boot seeder re-asserts `runtimeType: 'native'` each deploy for the three
  demo first-party apps (Scout exempt — per-user installs are not
  seeder-managed, verified negative). Any of the three following Scout onto
  the runtime requires the seeder change FIRST — no test fails today, the
  symptom is the runtime going quiet.
- `refresh-native-agent-configs` re-projects manifest config onto installs:
  an M1 per-install engine override survives boot but NOT a config refresh —
  the override must live outside projected config before the smoke flip.
Test tier: service-tier on the queue-transport swap (the partial-flip
surface); the M3 soak is dev-env and does not substitute.

### W3 — OpenClaw retirement (ADR-021 Part B) · PARALLEL AFTER RATIFICATION
Decoupled from pi (gates on native adequacy — met). Freeze → disposition (needs
**Sam's row-by-row call** on the 25-agent table) → infra excision → docs sweep.
Identity rule 8 absolute. Review amendments (sprint-review):
- **`verify:moltbot-tools` retires in the SAME PR as the submodule excision**
  — the CI step exits 2 the moment the submodule goes; the guard exists
  because of the submodule and dies with it.
- **The 14-day quiet gate becomes falsifiable**: a cluster-tier assertion of
  zero events dispatched to moltbot runtimes across the window, not an
  eyeballed waiting period.

### W4 — Onboarding funnel follow-ups · INSTRUMENT-FIRST (order inverted, ux-lead)
1. **`host: 'byo'` stamp** — one line + test; fixes an active honesty-surface
   lie (live pollers reading "unknown").
2. **`lastLogin` tracking** — the instrument; without it nothing downstream
   has an outcome measure.
3. **Stalled-connect trigger** — highest user value (all three casualties
   caught). **Spec claimed by ux-lead**: once per token-episode (reset on
   reissue), one post + presence escalation (no repeats), 15min patience,
   flat copy (never-used is structurally certain). Also converts "nobody's
   first mention has ever failed" from color into a monitored state — that
   line goes stale silently now that the funnel is whole.
4. **Opener redesign — judgment, NOT an experiment at n=2** (ux-lead): close
   with one concrete low-stakes offer scoped to something Scout observed in
   THEIR workspace; define typed-within-24h-of-opener now; measure the next
   cohort as a baseline, no attribution claims. Real-browser check required.
5. **Nudge decision** (Sam): whether to email the three stranded users.

### W5 — ADR-020 remainder · TRIGGER NOT YET MET (and currently UNWATCHED)
D6 second half (second human joins → auto-open user↔Scout DM, migrate cards).
Spec-before-build. Review amendments:
- **The trigger has no producer** (sprint-review): nothing watches
  human-membership transitions — "parked until trigger" is a permanent park.
  The detector derives where D6's first half already runs. Named work, Open.
- §3.10 is clean (pod-architect: one agent-room per human satisfies
  `DM_POD_TYPES_GUARD` by construction); W1's decider fix pre-solves the
  multi-human owner problem.
- **Card migration must re-post and re-point `messageId`** — rewriting
  `podId` alone strands the rendered card in the origin pod while socket
  updates go to the destination (pod-architect).

## Sequencing

```
W1 (days) ──────► W2-M1 ── M2 ── M3 ─ soak ─► M4 (credits, own pricing decision)
#938 merge ─┬───► W2 starts
            └───► W3 Phase 1 (freeze) ── 2 (disposition: Sam) ── 3 (teardown) ── 4
W4 items: independent, any order, small
W5: parked until trigger
```

## Decision ledger

| Decided (do not relitigate) | Open |
|---|---|
| Scout = tenant #1 on a general cloud-agent runtime; credits buy infra, not tokens | Merge #938 (starts W2 + W3) — Sam |
| CAP-queue transport; kernel-owned AgentRun | Disposition rows (any moltbot survivors?) — Sam |
| Manual fallback — **now DEFINED in #938** (trigger/mechanism/owner/granularity), was name-only | Nudge the three stranded users? — Sam |
| Scout stays native until runtime soak; native loop = fallback | Phase-3 teardown timing vs GTM — Sam |
| Retirement decoupled from pi | The pending "Sprint Planning" card — Sam |
| Smoke the shipped artifact, never repo source | **mcp 0.4.0 publish (web-OTP, W2 critical path)** — Sam |
| W1 decider = accountable human, never blind `pod.createdBy` | W5 trigger detector — named work, unowned |
| Claims protocol is M1, not M2 | W3 CI-guard pairing — rides the Phase-3 PR |

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
