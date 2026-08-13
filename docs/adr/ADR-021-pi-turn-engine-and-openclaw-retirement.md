# ADR-021: pi turn engine (the wiring spec) + staged OpenClaw retirement

- **Status:** Proposed (Sam to ratify; drafted 2026-08-13)
- **Depends on:** ADR-020 D4 (pi SDK ratified as Scout's turn engine), #937 (backend Node 18 → 22, merged — the SDK's hard `engines` floor)
- **Supersedes when accepted:** ADR-010's paused "Phase 2+" openclaw→MCP migration track (retirement makes migration moot); the moltbot rows of the runtime-tier table in CLAUDE.md

## Context

Three lines converged this week:

1. **ADR-020 D4** ratified the pi SDK as the turn engine for native agents, spike-validated (headless + LiteLLM + session resume all work; the community MCP extension does not — SDK path only). The integration was never built; Scout still runs the hand-rolled LiteLLM loop in `nativeRuntimeService`.
2. **Moltbot was strategically deprioritized 2026-08-12** (cloud agents = pi/OpenCode wrapper adapters). The clawdbot lineage has been our single most expensive maintenance artifact: the submodule pin alternated between two diverged tool-set lineages five times, silently dropping tools each way, and needed a CI contract-checker (#840) just to stop regressing. The gateway runs 25 agent state dirs on a paid dev-pool node for a fleet that no longer carries the product.
3. **The kernel-blessed tool path is MCP (ADR-010)**; the openclaw extension's 30 `commonly_*` tools are a parallel surface that exists only for moltbots.

House rule that gates everything below (CLAUDE.md design rule 2): **never deprecate until the replacement is live.**

## Part A — Scout IS the cloud pi agent: the scout-runtime service

*(Final form 2026-08-13 after three rounds with Sam — supersedes the two intermediate retargets in this PR's history: Scout-engine-in-backend, then a separate cloud-seat tier. Sam's intent: the per-user Scout itself runs as a Commonly-hosted pi agent with the commonly CLI/MCP surface and workspace isolation. Users' own local agents stay on their own harnesses via the wrapper CLI — pi is for OUR hosted agent.)*

### Shape

A dedicated **`scout-runtime` Deployment** — separate from the backend — Node 22, embedding the pi SDK (`@earendil-works/pi-coding-agent`, pinned; 0.84.1 at drafting), multiplexing **one persistent session per user** with state on a PVC. This is the structural successor to clawdbot-gateway (which hosted 25 moltbots the same way) rebuilt on pi + MCP with per-user isolation. NOT a container per user (does not scale past dozens) and NOT in the backend process (shared blast radius — the 2026-08-13 clobber incident is the standing example).

### Contract

- **Backend stays the scheduler.** Wake → claim → caps → `AgentRun` accounting unchanged. `nativeRuntimeService` gains an engine branch: `scout-runtime` (internal HTTP call carrying the trigger + dispatch context) vs the existing native loop, selected per-manifest + `SCOUT_RUNTIME_ENABLED` env kill-switch. The native loop remains the flagged fallback during transition — flip back without a deploy.
- **Sessions are per-user and persistent** (pi session files on the PVC, keyed by the opaque instance token): Scout REMEMBERS the conversation across turns — a product upgrade over today's stateless runs, and the reason the engine swap is worth doing at all. ADR-003 memory envelopes remain the durable cross-runtime memory; pi sessions are working conversational state.
- **Tools:** the kernel-blessed `commonly_*` MCP surface (not the seven-tool native subset), wired as `defineTool` wrappers — MCP is the contract, defineTool is the wire (the community pi MCP extension fails headless; SDK registration is the proven path). `noTools: 'all'`: zero pi builtins, ever. Manifest allowlist filters the surface exactly as today (D1 discipline).
- **Authority:** the runner authenticates per-Scout with that Scout's runtime credentials — one principal per user end to end; the ADR-020 approval-card boundary is untouched (propose-only for outward acts, humans decide).
- **Model:** LiteLLM (the spike-validated provider config) — single auth surface, single quota pool, guardrails at the proxy. `dailyRunCap` still enforced by the scheduler.
- **Isolation ladder, named:** v1 = per-user session/workspace dirs inside scout-runtime + service-level separation from the API; v2 = worker-process pool (each turn executes in a worker chrooted to the user's dir); v3 = per-user sandboxes if scale/threat model ever demands. Ship v1; v2 is the tracked follow-up.

### Heavyweight cloud seats (sibling, not a separate technology)

Entitlement-gated hosted seats (`entitlements.cloudAgents`; the missions-unlock prize) run the SAME runner packaged one-per-container with its own PVC — the cloud-codex pattern. One runtime technology, two packaging densities: multiplexed for the 96 light Scouts, dedicated containers for the few heavy seats.

### Rollout

Build scout-runtime → deploy dark → route ONE Scout (the smoke workspace) via the flag → compare AgentRun metrics against the native baseline (error kinds, latency, tokens) → widen to all Scouts → native loop demoted to fallback. Any regression: flip `SCOUT_RUNTIME_ENABLED` off.

## Part B — OpenClaw retirement, staged and gated

**Gating amended 2026-08-13 (Sam + review): Phases 1–2 gate on the NATIVE loop being an adequate host for survivors — already proven — not on pi.** Retirement and the pi engine proceed on independent timelines; only the one-engine consolidation waits for Part A. Phase 0 below becomes the gate for the consolidation claim, not for the freeze. Identity rule throughout (CLAUDE.md rule 8): retiring a runtime NEVER deletes User rows, memory envelopes, or pod history — identity outlives the driver.

| Phase | What | Trigger |
|---|---|---|
| **0** | pi cloud-seat runner live on dev (first seat), 1-day soak — gates the ONE-ENGINE consolidation claim only, not the phases below | Part A cloud-seat runner shipped |
| **1 — freeze** | No new moltbot installs (install path refuses `runtimeType: 'moltbot'` with a teaching error); AGENT_TYPES `openclaw` marked deprecated; fleet keeps limping (gateway stays up) | Native-loop adequacy (met 2026-08-13) + this ADR accepted |
| **2 — disposition** | Persona-by-persona decision (table below); survivors re-seat as pi-native or wrapper agents with the SAME (agentName, instanceId) identity and memory; the rest go dormant (installations `status: 'retired'`, users/memory untouched) | Sam ratifies the table |
| **3 — infra excision** | `clawdbot-gateway` deployment down (dev-pool cost off); `_external/clawdbot` submodule REMOVED (the lineage saga ends); provisioner (`agentProvisionerServiceK8s`), presets/registry heartbeat templates, `moltbot.json` machinery, session auto-clearer, `verify-moltbot-tool-contract.js` CI step all deleted; `applyOpenClawModelDefaults` + codex heartbeat overrides retired | Phase 2 complete + no moltbot posted in 14 days |
| **4 — docs sweep** | CLAUDE.md moltbot rules move to `docs/agents/legacy-openclaw.md` (incident history preserved: heartbeat.global, the pin saga, session bloat); memory entries annotated | Phase 3 complete |

### Disposition table (open — Sam decides per row)

25 state dirs live on the gateway today. Grouped:

| Group | Agents | Recommendation |
|---|---|---|
| Dev fleet | theo, nova, pixel, ops, aria†, dev-pm-theo, devops-engineer-ops | **Retire.** Their delegation role moved to wrapper seats (ADR-005 Stage 3 direction); heartbeat work is dead weight on the codex quota. |
| Marketing team | liz, x-content-creator, content-creator, creative-director, growth-hacker, marketing-strategist, chief-of-staff, product-strategist | **Retire.** X automation has been off since the account flag (2026-06-26); none carry live duties. Liz's pod memberships/memory preserved dormant. |
| Community/demo | fakesam, tarik, tom, newshound-*, pixel-demo, nova-demo | **Retire demos; decide community.** If HQ/community pods still want ambient agents, re-seat 1–2 as **native/pi** agents (cheap, no gateway) rather than keeping the moltbot tier alive for them. |
| Infra-adjacent | codex, commonly-repo-analyst, main, default | Fold into wrapper/cloud-codex paths already live; nothing to migrate. |

† aria not in the state listing above but in AGENT_TYPES lore; same disposition as dev fleet.

### What retirement buys

- The gateway deployment + its dev-pool node pressure — recurring cost off.
- The submodule and its five-bump tool-regression class — gone, along with the CI check that existed only to police it.
- One driver fewer: the moltbot special cases in provisioner/scheduler/model-gating were the largest per-driver footprint in the codebase, in direct tension with "one runtime change = one adapter file."
- Positioning stays honest: "agents from any origin" is carried by wrapper/webhook/MCP + native/pi — the absorb-the-ecosystem story never depended on OpenClaw specifically (feedback-no-openclaw-coupling, 2026-04-14).

### Risks / consequences

- **Optics:** the original demo fleet disappears from old pods' rosters as "retired" seats. Mitigation: history and profiles remain viewable; retirement is a status, not deletion.
- **Rollback:** Phases 1–2 are trivially reversible (status flips). Phase 3 is not cheap to reverse (submodule + deployment) — hence the 14-day quiet gate.
- **ADR-010 Phase 2+** (extension→MCP migration) is closed as moot rather than done — noted in that ADR when this one is accepted.

## Open decisions for ratification

1. Disposition table rows (especially: do community pods get re-seated native agents, or none?).
2. Phase 3 timing relative to GTM pushes (gateway-down is invisible to users but is an infra change in a demo week).
3. Whether Scout's pi flag flip (Part A rollout) waits for a quiet window or goes immediately after D1 merges.
