# Active Implementation Tracks

Moved verbatim from `CLAUDE.md` as part of the CLAUDE.md slim-down (TASK-528). Nothing in the body was reworded, dropped or re-dated.

### Active Implementation Tracks (April 2026)

**Strategic mode: shell-first pre-GTM (ADR-011, 2026-04-27).** Kernel work has reached a usable plateau; the binding constraint is now the surface humans see. Below, "🟢 active" tracks are in scope; "⏸️ paused" tracks have stated reactivation triggers in ADR-011 and should not be extended without lifting the pause.

| Track | Status | What it builds | Why it matters |
|-------|--------|---------------|----------------|
| 🟢 **Shell polish** | Phase 1 shipped 2026-04-29 (v2 mount on main, nav-rail trim, Plan/Execute pill, Your Team page, displayName-overrides for chat author render) — #62, #64, #65 still queue for next polish pass | Rich media, activity indicators, onboarding, empty/error states, mobile | Makes humans want to be there |
| 🟢 **Agent install + first-DM flow** | Top of queue | Hero path: install your first agent → talk to it. Agent Hub UX, install confirmation, first-message coaching | The 60-second value prop |
| 🟢 **Marketplace frontend** | Mid-queue (backend already shipped: PR #215 + #230, `/api/marketplace/*` 9 endpoints) | Browse page, manifest detail, publish flow, fork button — wiring on top of existing API. Pre-flight: end-to-end verify backend on dev. | Makes "discover an agent" real, not just "talk to the one we installed for you" |
| 🟢 **Landing + demo** | #71, #72 — mid-queue | Live stats API, public demo loop, landing page, README front-door | Gates external traffic |
| 🟢 **OSS launch prep** | #57–#59, #63 — tail of queue | README, community files, contribution path, self-hosting one-liner | Ecosystem growth |
| 🟢 **Agent DMs** | Shipped (stays) | 1:1 agent chat. `Pod.type: 'agent-room'` for human↔agent; `Pod.type: 'agent-dm'` for agent↔agent (autonomous via `commonly_open_dm` tool). "Talk to" in Agent Hub, "Agent DMs" pod tab. | Primary 1:1 surface — both for humans starting conversations and agents collaborating peer-to-peer |
| 🟢 **Native runtime (Tier 1)** | Shipped (stays) | In-process agent runtime via LiteLLM with `AgentRun` turn/tool/cost tracking | Zero-setup agents; powers first-party apps |
| 🟢 **First-party apps** | 3 shipped (stays) | `pod-welcomer`, `task-clerk`, `pod-summarizer` in Team Orchestration Demo pod | Reference implementations for the Installable model |
| ⏸️ **ADR-010 Phase 2+** | Paused (Phase 1 shipped) | OpenClaw → MCP migration, extension `commonly_*` retirement | Re-activates when a second runtime needs `commonly_*` mid-turn |
| ⏸️ **Installable taxonomy refactor** | Paused (Phase 1.5 + Phase 2 marketplace-ops shipped via PR #215 + #230; 2-remainder + 3–6 hold) | ADR-001 Phase 3 read-path switch (install reads from Installable, not AR), reconciliation cron, semver/runtime validation | Re-activates when marketplace frontend reveals a drift bug or a new Installable shape needs the read-path switch |
| ⏸️ **Cloud sandbox runtime (Tier 2)** | Paused | Anthropic Managed Agents + Commonly-hosted container adapter | Re-activates on real demand from a heavy-compute agent |
| ⏸️ **Slash command infrastructure** | Paused (taxonomy Phase 4) | `/command` addressing mode, command registry, UI autocomplete | Re-activates when an app/marketplace listing needs `/command` primary |
| ⏸️ **Kernel / CAP spec** | Paused — #61, #46 | OpenAPI spec + coupling reduction | Re-activates when federation work begins or a second instance comes online |
| ⏸️ **Driver layer expansion** | Paused — #69, #70 | Webhook SDK Phase 2 (OAuth, signatures), Agent SDK npm publish | Re-activates on real external developer demand |
| ⏸️ **Marketplace backend extensions** | Paused (9 publish/fork/browse endpoints already shipped via PR #215 + #230) | New endpoints, new manifest fields, recon cron | Re-activates when frontend or live use reveals a missing capability |
| ⏸️ **Self-hosting one-liner** | Paused — #60 | Docker Compose + Helm one-liner polish | Re-activates if OSS launch credibility demands it |

