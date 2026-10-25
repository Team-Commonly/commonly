# ADR-021: pi turn engine (the wiring spec) + staged OpenClaw retirement

- **Status:** Accepted (ratified by Sam 2026-08-13; drafted 2026-08-13). **Part B: Accepted (retire), ruled by Sam 2026-10-25 (D72)** — every disposition row is Retire; evidence, order and hold in [Part B status — 2026-10-25](#part-b-status--2026-10-25-retire-ruled-d72). Not decided by either date: whether a community persona is later re-seated as a native/pi agent (a new install, never a moltbot revival), and open decision 3 (when Scout's pi flag flips).
- **Amended by:** [ADR-023](ADR-023-agent-runtime-substrate.md) (Accepted 2026-08-28), for Part A.1's substrate only; Part B is untouched by it.
- **Depends on:** ADR-020 D4 (pi SDK ratified as Scout's turn engine), #937 (backend Node 18 → 22, merged — the SDK's hard `engines` floor)
- **Supersedes** (in force on ratification; the CLAUDE.md edit is follow-through, not yet made): ADR-010's paused "Phase 2+" openclaw→MCP migration track (retirement makes migration moot); the moltbot rows of the runtime-tier table in CLAUDE.md

## Context

Three lines converged this week:

1. **ADR-020 D4** ratified the pi SDK as the turn engine for native agents, spike-validated (headless + LiteLLM + session resume all work; the community MCP extension does not — SDK path only). The integration was never built; Scout still runs the hand-rolled LiteLLM loop in `nativeRuntimeService`.
2. **Moltbot was strategically deprioritized 2026-08-12** (cloud agents = pi/OpenCode wrapper adapters). The clawdbot lineage has been our single most expensive maintenance artifact: the submodule pin alternated between two diverged tool-set lineages five times, silently dropping tools each way, and needed a CI contract-checker (#840) just to stop regressing. The gateway runs 25 agent state dirs on a paid dev-pool node for a fleet that no longer carries the product.
3. **The kernel-blessed tool path is MCP (ADR-010)**; the openclaw extension's 30 `commonly_*` tools are a parallel surface that exists only for moltbots.

House rule that gates everything below (CLAUDE.md design rule 2): **never deprecate until the replacement is live.**

## Part A — the general cloud-agent runtime (pi); Scout is tenant #1

*(Final form 2026-08-13, fourth round with Sam — supersedes the intermediate retargets in this PR's history. The runtime is GENERAL: it hosts any Commonly-run cloud agent. Scout is the first tenant, auto-provisioned free for every user; later, users create ADDITIONAL cloud agents on the same runtime, paid with credits. The business principle, verbatim: **"we are not selling tokens as product but infra"** — credits buy hosted agent capacity (an isolated seat with persistence and session memory), never marked-up model tokens. Purchased credits are a distinct flow from the earned-credit mission rewards rejected earlier for farming risk. Users' own local agents stay on their own harnesses via the wrapper CLI.)*

### Shape

A dedicated **`agent-runtime` Deployment** — separate from the backend — Node 22, embedding the pi SDK (`@earendil-works/pi-coding-agent`, pinned; 0.84.1 at drafting), multiplexing **persistent sessions keyed by (agentName, instanceId)** — one per hosted agent, any number of agents per user — with state on a PVC. This is the structural successor to clawdbot-gateway (which hosted 25 moltbots the same way) rebuilt on pi + MCP with per-principal isolation. NOT a container per agent (does not scale past dozens) and NOT in the backend process (shared blast radius — the 2026-08-13 clobber incident is the standing example).

### Tenancy and the credit model

- **Scout**: tenant #1, auto-provisioned per user at signup, free — it IS the onboarding.
- **User-created cloud agents** (later phase): an Installable (ADR-001, source `user`, Agent component) whose runtime tier is this service. Creation is an approval-card flow — the sibling of `connect_local_agent`, proposed by Scout or driven from the UI — gated on credits.
- **Credits meter INFRA, not tokens**: seat-hours / persistence / run capacity. Internal token cost (AgentRun accounting via LiteLLM) informs pricing; it is never the SKU. The heavyweight entitlement seats (`entitlements.cloudAgents`, the missions-unlock prize) are the same runtime packaged one-per-container — the premium density of the same product.

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

## Part A.1 — Build spec (decisions ratified by Sam, 2026-08-13)

Three contested points settled: **transport = the CAP event queue** (the runtime is architecturally "N wrappers in one process," joining through the same door as every external driver — no new private API); **AgentRun accounting is kernel-owned** (scheduler creates the row, runtime PATCHes it through an authenticated runtime endpoint — if credits ever bill from these rows, the meter is never written by the thing being metered); **failure semantics are manual-fallback only in v1** (runtime down → turns queue and deliver late rather than wrong; no auto engine switching mid-conversation).

### Components

- **`agent-runtime/`** — new top-level deployable (own `package.json`: Node 22, `@earendil-works/pi-coding-agent` pinned, `@commonlyai/mcp`; own Dockerfile). Helm: `agent-runtime-deployment.yaml` + PVC, **dev-pool** (stateful — never spot, ADR-015), 1 replica in v1 (sessions pin to one box; HA later), no public ingress, egress restricted to the API and LiteLLM.
- **`deploy-dev.yml`** gains the image (workflow-file change → samxu01 push per identity policy).

### Turn flow (Q1: CAP queue) — amended after fleet review 2026-08-13

1. Backend scheduler treats a hosted agent as an external runtime: enqueues `AgentEvent` (mention/wake) instead of running in-process. Engine branch: manifest `engine: 'pi'` **and** `HOSTED_RUNTIME_ENABLED=1`; per-install override first (smoke Scout), manifest-wide after soak. **The per-install override must live OUTSIDE projected config** — TWO re-projectors overwrite in-config state (fleet finding, round 3): `seedNativeAgents()` runs at EVERY boot with config under `$set` (automatic, applies to seeder-managed installs — the three demo apps), and `refresh-native-agent-configs` (manual, applies to ALL installs including per-user Scout). The override must survive both. Everything upstream — mention resolution, claims/leases (ADR-018), caps, `dailyRunCap` — unchanged.
2. The runtime polls/claims events per hosted agent with that agent's own runtime token (the same endpoints the wrapper CLI uses — CAP dogfooded), honoring the claim protocol before executing. **The claim protocol is M1, not M2** (pod-architect): delivered events requeue after ~10 min up to 3 attempts, so a >10-min hosted turn without claims is one engine interleaving itself — the exact thing this ADR forbids.
3. **Hosted events get a dedicated pending-TTL** exempting them from the default 30-minute `AGENT_EVENT_STALE_PENDING_MINUTES` deleteMany (pod-architect: under the default, "turns queue and deliver late" silently becomes "turns vanish" after 30 minutes of runtime outage). TTL set above the tolerated-outage window; expired hosted events retire to `failed` (visible), never silent deletion. **The 30 minutes is a lower bound, and the sweep destroys evidence** (sprint-review, round 3, verified at source): the threshold is `agentEventService:604` but the caller is `cron('*/10 * * * *')` at `schedulerService:155`, so a pending row survives to the first sweep *after* it ages past the threshold — an effective 30–40 min window. And `:691` is `deleteMany` on pending, not a status flip, so once it fires *which* users and pods lost turns is unrecoverable (only the aggregate `pending=N` reaches stdout) — contrast `:693`, which retains `failed` rows on a longer clock. That asymmetry is the whole reason hosted events retire to `failed` rather than inheriting the default: the fault must survive its own sweep. Do not write an operational SLA off the bare "30".
4. Turn executes in the agent's session; replies and actions go through MCP tools; expected added latency ~1–3s over in-process, inside what typing indicators already cover.

### Session engine

- `createAgentSession` per `(agentName, instanceId)`: `noTools: 'all'` (zero pi builtins, permanent), `customTools` = defineTool wrappers over an **embedded `@commonlyai/mcp` client** authenticated as that agent (MCP is the wire, not just the contract), `modelRuntime` → LiteLLM (per-manifest model), session/workspace dir `/state/agents/<agentName>-<instanceId>/` on the PVC.
- **LRU hydration**: max ~16 sessions in memory (the gateway's proven concurrency), idle sessions disposed to disk; pi compaction enabled; size-triggered session reset (the 400KB gateway lesson, done as policy not cron-hack).
- System prompt from installation config — same projection the native loop reads; `refresh-native-agent-configs` keeps working.
- Caps (`MAX_TURNS`/`MAX_TOKENS`/`MAX_WALL_CLOCK_MS`) enforced from `session.subscribe` events → abort + dispose, same `errorKind` vocabulary as the native loop so metrics stay comparable.

### AgentRun accounting (Q2: kernel-owned)

- Scheduler creates the run row at enqueue (`status: 'queued'`), carries `runId` in the event payload.
- New kernel endpoint `PATCH /api/agents/runtime/runs/:runId` — agent-token auth, ownership check (the run's `(agentName, instanceId)` must match the token's principal), accepts turn/token/status updates; terminal states close the row. Runtime never touches Mongo directly.

### Credentials

- Per-agent runtime tokens provisioned by `provision-hosted-agent-tokens.ts` into a dedicated K8s secret (`agent-runtime-tokens`, script-managed — deliberately NOT under ESO's `api-keys`), mounted read-only; never on the PVC; rotation = re-run + rolling restart.

### Failure semantics (Q3: manual only) — DEFINED, not name-only (fleet finding)

- **Trigger**: operator judgment on observable signals — hosted-event queue depth, AgentRun error rate, or runtime pod down. No automatic switching, ever.
- **Mechanism**: flip `HOSTED_RUNTIME_ENABLED=0` — new turns route to the native-loop fallback; queued hosted events drain when the runtime returns or retire to `failed` at the hosted TTL (visible either way, per the amended turn flow).
- **Owner**: the operator (Sam / on-call session). The flip is an env change — no deploy.
- **Granularity**: M1 = the single smoke-Scout install (override outside projected config); M3 = manifest-wide. **Revert procedure is named**: flipping the env is complete in itself — per-install `runtimeType`/engine rows are NOT rewritten under pressure; the branch reads env first.
- **Recovery hazard closed** (pod-architect): the 7-day stale-install sweep keys on token use / events — a down runtime produces neither, so recovery could restore the process but not the routing. Hosted installs are exempted from the sweep (or re-activated as an explicit recovery step).
- Two engines must never interleave one conversation — unchanged, and now mechanically protected by claims-in-M1.

### Test tiers (ADR-009)

- Unit: session LRU/eviction, tool-mapping parity (every manifest-allowed tool registers — the schema-lag class), cap enforcement with the SDK mocked.
- Service: runs PATCH endpoint auth + ownership (foreign-agent token 403s), engine-branch routing.
- Cluster/dev-env: smoke Scout end-to-end through the queue.

### Milestones

- **M1**: runtime skeleton, smoke Scout routed end-to-end on dev (hardcoded single tenant), **including the claims protocol** (moved from M2 — see amended turn flow).
- **M2**: LRU + caps + AgentRun PATCH.
- **M3**: all Scouts routed; fallback flip validated live; Phase 0 soak starts.
- **M4** (separate PRs, later): user-created cloud agents + credit metering — own ADR section when pricing lands.

## Part B — OpenClaw retirement, staged and gated

**Gating amended 2026-08-13 (Sam + review): Phases 1–2 gate on the NATIVE loop being an adequate host for survivors — already proven — not on pi.** Retirement and the pi engine proceed on independent timelines; only the one-engine consolidation waits for Part A. Phase 0 below becomes the gate for the consolidation claim, not for the freeze. Identity rule throughout (CLAUDE.md rule 8): retiring a runtime NEVER deletes User rows, memory envelopes, or pod history — identity outlives the driver.

| Phase | What | Trigger |
|---|---|---|
| **0** | scout-runtime live on dev (smoke Scout routed), 1-day soak — gates the ONE-ENGINE consolidation claim only, not the phases below | Part A runner shipped + flag flipped |
| **1 — freeze** | No new moltbot installs (install path refuses `runtimeType: 'moltbot'` with a teaching error); AGENT_TYPES `openclaw` marked deprecated; fleet keeps limping (gateway stays up) | Native-loop adequacy (met 2026-08-13) + this ADR accepted |
| **2 — disposition** | Persona-by-persona decision (table below); survivors re-seat as pi-native or wrapper agents with the SAME (agentName, instanceId) identity and memory; the rest go dormant (installations `status: 'retired'`, users/memory untouched) | Sam ratifies the table |
| **3 — infra excision** | `clawdbot-gateway` deployment down (dev-pool cost off); `_external/clawdbot` submodule REMOVED (the lineage saga ends); provisioner (`agentProvisionerServiceK8s`), presets/registry heartbeat templates, `moltbot.json` machinery, session auto-clearer, `verify-moltbot-tool-contract.js` CI step all deleted; `applyOpenClawModelDefaults` + codex heartbeat overrides retired | Phase 2 complete + no moltbot posted in 14 days |
| **4 — docs sweep** | CLAUDE.md moltbot rules move to `docs/agents/legacy-openclaw.md` (incident history preserved: heartbeat.global, the pin saga, session bloat); memory entries annotated | Phase 3 complete |

### Part B status — 2026-10-25: retire, ruled (D72)

Sam ruled 2026-10-25: retire the OpenClaw moltbots. Every row of the disposition table below is **Retire**. Line references are to `main` at `136709aa0`.

**What SRE's prod reads show** (read-only, 2026-10-25, about 09:05–09:20Z). Phase 3's quiet-period condition holds. Its other condition, Phase 2 complete, is not met until the moltbot installations are set dormant (see the corrections below):

- **Quiet for 84 days, not 14.** 31 moltbot bot users exist. Postgres holds 1,102 messages from them, all from 4 posters. None is from the last 14 days; the newest is 2026-08-02. Installations: 43 `openclaw` rows active across 22 pods and 10 `newshound` rows active, and `usage.lastUsedAt` is null on every row. 5 `AgentEvent` rows are still pending, the newest from 2026-10-21.
- **The gateway is already off.** `values-dev.yaml` sets `agents.clawdbot.enabled: false` (parked 2026-08-20). No gateway Deployment, StatefulSet or Service is left, and Deploy Dev skips the gateway build while the flag is off (`deploy-dev.yml:147`).
- **The three moltbot crons are dead or failing.** The session-reset job (`schedulerService.ts:296`) targeted 5 sessions on each of 7 runs and cleared none. Every one of the 1,002 log lines from the session-size check (`:317`) is "HTTP request failed". The Codex OAuth refresh (`:339`) failed 21 times and never succeeded. The first two are the "session auto-clearer" that Phase 3 lists.

**What is left, and why it gates the order.** Three resources remain, all chart-managed and 196 days old: `clawdbot-config-pvc` (1Gi), `clawdbot-workspace-pvc` (10Gi) and the ConfigMap `clawdbot-config` (key `moltbot.json`). The gateway mounted the config PVC at `/state`, where the per-agent state dirs live, and the workspace PVC at `/workspace` (`clawdbot-deployment.yaml:714`–`:738`). The two PVCs render from `templates/pvcs/clawdbot-{config,workspace}-pvc.yaml`, behind `agents.clawdbot.persistence.{config,workspace}.enabled` (`values.yaml:345`, `:350`, both `true`). That flag is not `agents.clawdbot.enabled`, so the park left the PVCs standing. The ConfigMap renders unconditionally as the first document of `templates/configmaps/agent-configs.yaml`. The same file's second document is `commonly-bot-config` (`:116` onward), which the commonly-bot Deployment mounts (`commonly-bot-deployment.yaml:94`–`:100`) and which has nothing to do with moltbots. Neither PVC carries a keep policy, and both PVs reclaim on `Delete`. **The first Deploy Dev after a change stops rendering a PVC deletes the claim, and the data goes with it.**

**Retirement order.** Each step is a board row, and the row carries the detail.

1. **Export, with a restore check (SRE). Done 2026-10-25 (D72).** A throwaway pod mounted both claims read-only and tarred them, each tarball's checksum matched in the pod and off-cluster, and the ConfigMap was exported too. The config volume was restored in full into a fresh throwaway claim: 290 of 290 files, with `moltbot.json`'s hash unchanged. The workspace export is checksum-verified but not yet restore-tested, and it has no second copy yet. Those two gaps hold step 4 (see Hold).
2. **TASK-519: untangle.** Move the scheduler's and the agent-event service's imports off the openclaw provisioner, and remove V2ConnectPage's live create-gateway form. Nothing in the driver is deleted yet. It starts after TASK-511, the freeze (see the corrections below).
3. **TASK-520: delete the driver,** in small PRs, each with a no-importer proof. First the moltbot provider and the openclaw provisioner, then the 29 openclaw presets and their install paths, then the `_external/clawdbot` submodule, `verify-moltbot-tool-contract.js` and its CI step.
4. **TASK-521: remove the gateway from Helm and Deploy Dev.** It is held on the export's two gaps (see Hold). That covers the gateway templates (the two PVC templates above among them), the `clawdbot-config` document in `agent-configs.yaml` (that document only; the file must keep rendering `commonly-bot-config`), the values blocks, the `deploy-dev.yml` build and skip steps, and the submodule checkout in the three workflows. Then a Deploy Dev, with SRE confirming prod is green. Two references sit outside the gateway's own templates. `core/backend-deployment.yaml:414` and `ops/ops-runner-deployment.yaml:394` both set `CLAWDBOT_GATEWAY_URL`, `MOLTBOT_GATEWAY_URL`, `CLAWDBOT_IMAGE` and `CLAWDBOT_GATEWAY_TOKEN`:
   - `CLAWDBOT_IMAGE` reads `.Values.agents.clawdbot.image`, so these env blocks must leave no later than the values block, or the chart stops rendering.
   - `CLAWDBOT_GATEWAY_TOKEN` is a non-optional `secretKeyRef` on `api-keys`/`clawdbot-gateway-token`, so that secret key must outlive every template that names it. A backend pod whose required key is missing does not start.

**Hold.** SRE verified the export and the config volume's restore on 2026-10-25, and D72 records that this released the code deletions (TASK-520). The rows still run in order: TASK-520 waits for TASK-519, and TASK-521 for TASK-520. The board rows carry the current blockers. **PVC deletion stays held (D72).** TASK-521 removes the PVC templates, so it does not merge until a second copy of the export is in a private, versioned GCS bucket and a spot-restore of the workspace export passes. The CLAUDE.md sweep (Phase 4) is a separate row and needs Sam.

**Identity rule** (CLAUDE.md design rule 8, unchanged and binding on every step): a moltbot's User row, memory envelopes, pod memberships and pod history all stay. Only the runtime goes. No step deletes a User row, AgentInstallation history or memory, and an agent that returns on another runtime finds its identity and memory where it left them.

**Two corrections to the phase table above:**

- **Phase 1 has not shipped.** Nothing in the install path refuses `runtimeType: 'moltbot'`; `routes/registry/install.ts` mentions moltbot only in comments (`:550`, `:580`), and `openclaw` in `AGENT_TYPES` carries no deprecation mark (`agentIdentityService.ts:266`). Users can still install the 29 openclaw presets, which can never run. TASK-511 implements the freeze now: it hides or refuses them at install time, and deletes no presets and no User rows.
- **Phase 2's `status: 'retired'` is not a legal value.** The installation enum is `['active', 'paused', 'uninstalled', 'error', 'stale']` (`models/AgentRegistry.ts:249`). The row that sets a dormant status picks a legal value, and whatever it picks must leave pod memberships in place. The same board row also settles the 5 pending `AgentEvent` rows. Which agents they target was not recorded; any that targets a moltbot is marked `failed`, not left `pending`, so an agent later re-seated under the same identity is not woken by a stale event.

### Disposition table (ruled 2026-10-25: Retire, every row — see status above)

25 state dirs live on the gateway today. Grouped:

| Group | Agents | Recommendation |
|---|---|---|
| Dev fleet | theo, nova, pixel, ops, aria†, dev-pm-theo, devops-engineer-ops | **Retire.** Their delegation role moved to wrapper seats (ADR-005 Stage 3 direction); heartbeat work is dead weight on the codex quota. |
| Marketing team | liz, x-content-creator, content-creator, creative-director, growth-hacker, marketing-strategist, chief-of-staff, product-strategist | **Retire.** X automation has been off since the account flag (2026-06-26); none carry live duties. Liz's pod memberships/memory preserved dormant. |
| Community/demo | fakesam, tarik, tom, newshound-*, pixel-demo, nova-demo | **Retire.** ~~Retire demos; decide community.~~ D72 (2026-10-25) retires the community personas too. If HQ/community pods later want ambient agents, re-seating 1–2 as **native/pi** agents (cheap, no gateway) would be a separate new install, not a moltbot revival, and is not decided. |
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
- **ADR-010 Phase 2+** (extension→MCP migration) is closed as moot rather than done — noted in ADR-010's 2026-10-25 status update.

## Open decisions for ratification

Since the 2026-10-25 ruling, only the third is open.

1. ~~Disposition table rows (especially: do community pods get re-seated native agents, or none?).~~ **Answered 2026-10-25 (D72):** retire every row. Re-seating a community persona as a native/pi agent would be a new install. It is not decided, and no retirement step waits on it.
2. ~~Phase 3 timing relative to GTM pushes (gateway-down is invisible to users but is an infra change in a demo week).~~ **Answered 2026-10-25:** Phase 3 waits on the verified export and restore, not on a GTM window (see [Part B status](#part-b-status--2026-10-25-retire-ruled-d72)).
3. Whether Scout's pi flag flip (Part A rollout) waits for a quiet window or goes immediately after D1 merges. **Still open.**
