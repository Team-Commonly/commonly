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

## Part A — pi turn engine wiring spec (D1)

Verified against the real SDK (`@earendil-works/pi-coding-agent@0.84.1`, types read from dist, pinned exactly — upstream releases every few days).

### Seam

`nativeRuntimeService.executeRun` gains one branch before the existing while-loop:

```ts
if (engineForConfig(cfg) === 'pi') return runPiTurn(engineInput);
// existing LiteLLM loop — untouched, remains the default
```

- `engineForConfig(cfg)`: `'pi'` iff `cfg.engine === 'pi'` **and** `process.env.PI_ENGINE_ENABLED === '1'`. Manifest field `engine?: 'native' | 'pi'` added to `NativeAgentDefinition`; Scout declares `'pi'` first. Env is the ops kill-switch — merging D1 changes nothing until flipped.
- Backend remains the scheduler: wake/claim/caps/`AgentRun` rows/typing/`dailyRunCap` are all upstream of the seam and unchanged.

### `runPiTurn` contract

```ts
const session = await createAgentSession({
  noTools: 'all',                    // ZERO pi builtins: no bash/read/edit/write, ever
  customTools: commonlyToolsFor(cfg, dispatchCtx),  // defineTool(...) wrappers
  modelRuntime,                      // LiteLLM as an OpenAI-compatible provider
  agentDir: <ephemeral scratch>,     // never ~/.pi — no shared state between principals
});
try {
  const unsub = session.subscribe(onEvent);   // → AgentRun turns/tokens/toolCalls
  await session.prompt(userMessage, { ... }); // system prompt via session config
} finally { session.dispose(); }              // session-per-run; no reuse in v1
```

- **Tool mapping:** each entry in the existing `TOOLS` array wraps into a pi `ToolDefinition` — `name`/`description` copied verbatim, `parameters` passed through (TypeBox schemas are JSON-Schema-shaped; a parity test asserts every gated tool registers), `execute(toolCallId, params)` → the existing `dispatchTool(name, params, dispatchCtx)`. **One dispatcher, two engines** — capability boundary (D1 gating via `toolsForConfig`) applies before mapping, so the pi session sees exactly the manifest allowlist.
- **Caps:** `MAX_TURNS` / `MAX_TOKENS` / `MAX_WALL_CLOCK_MS` enforced by the wrapper from subscribe-events; breach → abort + `dispose()` + the same `errorKind` vocabulary (`turn_cap` / `token_cap` / `timeout`) so AgentRun metrics stay comparable across engines.
- **`postedViaTool` semantics carry over** (post/propose mark it; fallback-post only when unset) — the double-post guard is engine-independent.
- **Guardrails:** LiteLLM-side guardrails ride the provider call unchanged (they live at the proxy, not the loop).
- **Isolation:** session-per-run + `dispose()` + ephemeral `agentDir` means no cross-user state can accumulate in the engine layer. This is the first concrete D5 step; per-manifest worker-process execution is the next one and is out of scope here.
- **Tool surface (amended 2026-08-13, Sam):** pi-Scout targets the kernel-blessed **MCP toolset** — the same `commonly_*` surface BYO/MCP agents get — not just the seven native-loop tools. Implementation stays defineTool wrappers over our own handlers (same dispatch authority, same D1 manifest-allowlist filtering); MCP is the contract, not necessarily the wire. The weiaodi incident (你好 into an agentless room) is the standing reminder of why the per-user agent must be a first-class citizen of the full kernel surface.
- **Workspace isolation (amended 2026-08-13, Sam):** each session gets an ephemeral per-user workspace directory as its `cwd`/`agentDir` (created per run, destroyed with `dispose()`); a worker-process pool for true OS-level isolation is the named Phase 2 of this track — NOT a wrapper-process-per-user, which cannot scale to the 96 Scouts now installed. The scheduler-multiplexed session model IS the per-user pattern; the CLI wrapper pattern remains for heavyweight cloud seats.
- **Session resume** (pi `-c`, spike-validated) is deliberately **not** in v1 — today's loop is stateless per run; resume is a later phase with its own ADR note when conversational memory-in-engine is wanted.

### Rollout

Merge dark → flip `PI_ENGINE_ENABLED=1` on dev in a quiet window → Scout runs one day on pi with AgentRun metrics compared against the native-loop baseline (error kinds, latency, tokens) → leave on. Any regression: flip the env off; no deploy needed.

## Part B — OpenClaw retirement, staged and gated

**Gating amended 2026-08-13 (Sam + review): Phases 1–2 gate on the NATIVE loop being an adequate host for survivors — already proven — not on pi.** Retirement and the pi engine proceed on independent timelines; only the one-engine consolidation waits for Part A. Phase 0 below becomes the gate for the consolidation claim, not for the freeze. Identity rule throughout (CLAUDE.md rule 8): retiring a runtime NEVER deletes User rows, memory envelopes, or pod history — identity outlives the driver.

| Phase | What | Trigger |
|---|---|---|
| **0** | pi engine live for Scout on dev, 1-day soak, metrics parity | D1 merged + flag flipped |
| **1 — freeze** | No new moltbot installs (install path refuses `runtimeType: 'moltbot'` with a teaching error); AGENT_TYPES `openclaw` marked deprecated; fleet keeps limping (gateway stays up) | Phase 0 passes |
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
