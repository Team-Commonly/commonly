# V2 UI smoke + gap analysis — findings (2026-05-23)

**Worktree**: `.claude/worktrees/ui-smoke-2026-05-23` off `main@e89670a5`.
**Stack**: `./dev.sh up` local Docker Compose + kubectl port-forward to dev cluster's LiteLLM.

## Capsule

- **Local deploy path works** end-to-end now that the native-runtime install bug is fixed and LiteLLM creds are wired (PR #434 just landed for the install bug).
- **V2 shell core** (login → pod → chat → composer) is polished and clean — 0 console errors on the happy path.
- **V2 nav rail has 4 tabs (Pods, Agents, Apps, Settings)**. Of those, Pods + Agents are well-built v2-native. **Apps (=Marketplace) and Settings are legacy MUI components mounted under v2** and are real gap surfaces.
- **Default post-login route is `/feed` (legacy)**, not `/v2`. New users don't see v2 until they manually navigate.
- **Mobile breakpoint broken below ~1100px** (memory confirmed in walkthrough; inspector fills viewport, layout collapses).
- **Two agent-runtime adapter paths verified locally**: native in-process and CLI-wrapper polling.

## Detailed findings

### Bugs

| # | Severity | Where | Fix |
|---|---|---|---|
| F1 | P0 | `/api/registry/install` writes `runtime={}` for native first-party apps installed via UI — events route to external queue, agent never replies | **PR #434 shipped** (registry-manifest fallback for runtimeType) |
| F2 | P0 | V2 marketplace (`/v2/marketplace`) calls `/api/apps/marketplace*` (legacy shadows) instead of `/api/marketplace/browse` — Discover and Installed counts are 0 even after installs | (separate PR; backend already shipped via #215/#230) |
| F3 | P1 | Default post-login route is `/feed` (legacy) | router change in `App.tsx` |
| F4 | P1 | Chip click in agent-room empty-state fills composer but doesn't auto-send | add `submit` to chip click handler |
| F5 | P1 | V2 Settings has only 3 tabs (Overview / Apps / API Token) — no Account-security, no Pod settings, no Admin sub-page | redesign per `settings-v2-gaps.md` |
| F6 | P1 | "Apps Marketplace" link inside Agent Hub goes to `/apps` (legacy) | update to `/v2/marketplace` |
| F7 | P1 | Mobile breakpoint broken below ~1100px (memory: `project-v2-mobile-not-responsive`) | responsive sprint; deferred per ADR-011 |
| F8 | P2 | Apps tab label vs Marketplace heading mismatch | pick one |

### Surface inventory (TL;DR)

| V2 surface | Status |
|---|---|
| Pods + chat + composer | ✅ Polished, v2-native |
| Agents (Your Team / Hire) | ✅ Polished, v2-native |
| Agent install + agent-room | ✅ Polished, v2-native |
| Marketplace (`/v2/marketplace`) | ❌ Legacy MUI, wrong endpoints |
| Settings (`/v2/settings`) | ⚠️ Legacy MUI wrapped, account-only |
| Landing (`/`) | ⚠️ Legacy, dark/gradient theme; v2 design proposal drafted (see `landing-v2-proposal.md`) |

### Subagent gap audits (separate files)

- `marketplace-v2-gaps.md` — endpoint map + 2-3 PR redesign plan
- `settings-v2-gaps.md` — surface inventory + minimal v2 hub proposal
- `landing-v2-proposal.md` — v2 landing design (hero ASCII mock, sections, implementation footprint)
- `local-agent-runtimes-verified.md` — recipes for native + CLI-wrapper paths
- `walkthrough-2026-05-23.md` — beat-by-beat UI walk

### Agent-runtime paths verified

1. **Native (in-process)** — Pod Welcomer replies via `nativeRuntimeService.runAgent` → LiteLLM → reply ~3-5s. Unlocked by PR #434.
2. **CLI-wrapper (ADR-005)** — `stub` adapter polls local backend, echoes back. Same pattern OpenClaw + Codex CLI use. Verified end-to-end in /tmp/local-stub.log.

### What didn't get verified

- **OpenClaw clawdbot-gateway local** — needs CLAWDBOT_GATEWAY_TOKEN + OPENCLAW_USER_TOKEN + OPENCLAW_RUNTIME_TOKEN; token chain isn't auto-bootstrapped from a fresh local stack. Path-of-least-resistance: provision a clawdbot installation, harvest tokens, then `./dev.sh clawdbot up`.
- **Real `codex` / `claude` CLI adapters** — laptop has neither installed; the wrapper code-path is exercised by `stub`. Runtime gap is operator setup, not code.
- **Agent-DM §3.7 fan-out** — needs an agent that calls `commonly_open_dm` to spawn a 1:1 agent↔agent DM. Native pod-welcomer doesn't; stub doesn't. Defer.

## Recommended next sprint (post-this-session)

P0 first:
1. **PR for F2** — rewire `/v2/marketplace` to call `/api/marketplace/browse` and friends. Add detail page `/v2/marketplace/:id`. Token-align with v2.css. ~3-4 days per subagent recommendation.
2. **PR for F3** — change default post-login route to `/v2`. One-line router change.

P1 batch:
3. **PR for F4** — chip click should send. One-line composer change.
4. **PR for F6** — fix "Apps Marketplace" cross-link in Agent Hub.

Bigger landings:
5. **V2 Settings hub** per `settings-v2-gaps.md` — Phase 1 (Account security + My Pods member mgmt), ~2-3 days.
6. **V2 Landing** per `landing-v2-proposal.md` — ~700 LOC, 1 PR.
7. **Mobile responsive** — separate sprint per ADR-011 cadence.

## Knowledge-base updates ready to ship

- **Memory entry**: `project-2026-05-23-v2-ui-smoke.md` — sprint outcome + PR #434 fix + the four audit docs as pointer artifacts.
- **No new prescriptive rule** surfaced (the install fix is shipped as code; the audit gaps are roadmap items, not rules).
- **No new skill** needed; existing `frontend-dev`, `agent-runtime`, `installable-taxonomy` skills already cover the surface.
