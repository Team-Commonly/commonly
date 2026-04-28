# ADR-011: Shell-first pre-GTM

**Status:** Draft — 2026-04-27
**Author:** Sam Xu
**Companion:** [`ADR-010`](ADR-010-commonly-mcp-server.md) (Phase 2+ paused under this ADR), [`CLAUDE.md`](../../CLAUDE.md) §Design Rules #5 ("the social surface has to earn human presence")

---

## Context

The kernel work has reached a natural pause. Through April 2026 we shipped:

- ADR-004 (CAP) — the four-verb driver-facing surface, frozen.
- ADR-005 Stage 2 — `sam-local-codex` live as the first production CLI-wrapper agent.
- ADR-006 Phase 1 — webhook SDK + self-serve install.
- ADR-008 — agent environment primitive (workspace / sandbox / skills / MCP).
- ADR-009 Phases 1/1.5/2 — test tiers + CI/CD substrate.
- ADR-010 Phase 1 — `@commonly/mcp` stdio server + `/room` dual-auth.
- Native runtime (Tier 1), Agent DMs, three first-party apps, `Skill` as the 8th component type.

The kernel can host agents from any origin. Local CLI wrappers join. Webhook agents join. The MCP surface exists for any runtime that wants it. CAP is stable. **The platform is no longer the binding constraint on adoption.**

What *is* the binding constraint: the surface a human sees in the first 60 seconds. Right now we don't have a confident answer to "what does a new user do on landing." Onboarding, agent-install flow, mobile, demo loop, landing page — all are the work between "the platform exists" and "someone wants to use it." Per CLAUDE.md design rule #5, *the social surface has to earn human presence* — and that earning hasn't been built yet.

The forcing function is GTM. We can't ship the platform vision without humans on it; humans don't stay without a shell that earns their presence; the shell isn't there yet. Continuing to build kernel primitives doesn't move that needle.

---

## Decision

**Pause new kernel work. Make shell quality, user experience, and GTM readiness the active track until the shell earns presence.**

### What's paused

| Track | What pauses | Reactivation trigger |
|---|---|---|
| **ADR-010 Phase 2+** (OpenClaw → MCP migration, extension deprecation) | No further fork PRs to retire `commonly_*`; no new mcpServers wiring in `/state/moltbot.json` | A second runtime needs `commonly_*` mid-turn and the extension can't serve it; or per-agent token wiring story converges; or post-GTM |
| **Cloud sandbox runtime (Tier 2)** | No Anthropic Managed Agents adapter, no Commonly-hosted container driver | Real demand from a heavy-compute agent that can't run on Tier 1 |
| **Slash command infrastructure** (Phase 4 of taxonomy refactor) | No `/command` registry, no autocomplete UI | A first-party app or marketplace listing needs `/command` as its primary addressing mode |
| **Driver layer expansion** (#69, #70 — Webhook API + Agent SDK npm publish) | ADR-006 Phase 1 substrate stays; no Phase 2 features (OAuth, webhook signatures, npm publish) | Real external developer asking to build against it |
| **CAP OpenAPI spec** (#61, #46) | No formal OpenAPI generation, no coupling-reduction refactor | Federation work begins (ADR-003 Phase 5) or a second instance comes online |
| **Self-hosting one-liner** (#60) | No Docker Compose / Helm chart polish for OSS contributors | OSS launch is the active track (see Active below — this re-activates) |
| **Installable taxonomy refactor** Phase 2-6 | Schema work pauses except where it unblocks shell features | Marketplace UI build needs the unified `Installable` query path |

### What's active

| Track | What ships | Owner / cadence |
|---|---|---|
| **Shell polish** (#62, #64, #65) | Onboarding flow, rich media in chat, activity indicators, empty/error states, mobile responsiveness | Top of queue; iterate weekly |
| **Agent install + first-DM flow** | The "install your first agent → talk to it" hero path: Agent Hub UX, install confirmation, first-message coaching, identity polish | Top of queue |
| **Landing + demo** (#71, #72) | Live stats API, public demo loop, landing page, README front-door | Mid-queue; gates external traffic |
| **OSS launch prep** (#57–#59, #63) | README polish, community files, contribution path, self-hosting one-liner if needed for credibility | Tail of queue but reuses self-hosting work above |

### What stays load-bearing regardless

- **Kernel stability.** CAP doesn't change, ADR-001/004/008 invariants hold, agent identity continuity is preserved across reinstalls. Shell work cannot break the kernel.
- **CI/CD pipeline (ADR-009).** The deploy path stays green; the test tiers don't regress.
- **Live agents.** sam-local-codex, Liz, x-curator, the dev agents — all remain operational. Shell work is additive, not destructive (per CLAUDE.md design rule #2).
- **Critical bug fixes.** Production breakage on the kernel is fixed when it happens; this ADR doesn't gate emergency repair.

---

## Load-bearing invariants

1. **Shell-first does not mean kernel-broken.** Any shell change that requires a kernel change goes through normal ADR review. The kernel doesn't bend to make a shell flow easier — the shell uses what the kernel exposes.
2. **No new driver-coupling debt while paused.** The openclaw extension's `commonly_*` block is frozen at its current verb set. New cross-driver verbs do not get added to the extension during the pause; they wait for ADR-010 Phase 2 or get scoped out.
3. **Pauses are reversible.** Every paused track has a stated reactivation trigger above. When a trigger fires, the track resumes — not "starts a debate about whether to resume."
4. **Audit before commit.** The first concrete deliverable under this ADR is a first-impression UX audit (Playwright walk-through, screenshots, paper-cut list). The audit's output drives what we actually build; we do not commit to specific features without seeing the surface.
5. **Don't rewrite to refactor.** Shell polish is polish — onboarding, microcopy, empty states, mobile, animation, error messages. Not "rewrite the chat module." If a polish task uncovers a real architectural issue, file an ADR; don't expand the shell work to swallow it.

---

## What this is not

- Not a freeze on all engineering. CI, deploys, and bug fixes continue.
- Not a deprecation of the kernel. ADR-010's load-bearing invariants remain in effect; Phase 1 stays consumed by sam-local-codex.
- Not a dismissal of the paused tracks. They have stated reactivation triggers; when triggers fire, work resumes.
- Not a marketing-driven feature schedule. GTM here means making the existing platform usable enough that someone who lands on it stays — not building features to chase a launch press cycle.

---

## Open questions

1. **What's the GTM target?** "OSS launch," "YC demo," and "first 100 users on commonly.me" are different bars and would prioritize different shell work. Sub-decision needed before the audit converges into a feature plan.
2. **Mobile-first or desktop-first audit?** The current shell renders on both but isn't optimized for either. The first-impression audit needs to pick one to go deep on first; the other gets a triage pass.
3. **First-party agent showcase.** The three first-party apps (`pod-welcomer`, `task-clerk`, `pod-summarizer`) live in the Team Orchestration Demo pod. Are they the demo loop, or do we need a different shape (e.g., a single hero agent with a richer interaction) to anchor first-impression?
4. **Marketplace before or after audit?** Marketplace UI (#66, #67, #68) is paused, but Agent Hub *is* the proto-marketplace UX. Audit may surface that we need marketplace browse to make agent install feel real.

---

## Rejected alternatives

**"Keep going on ADR-010 Phase 2 because it's almost done."** It isn't almost done. Per-agent token wiring is unsolved and the two `commonly_update_task` shapes need reconciliation. Finishing it would be 1–2 more weeks of real work, with the live exercise gated on whether dev agents pick up tasks (which they currently don't reliably). The marginal return on that work is lower than the return on a shell that earns first-impression presence.

**"Do shell + kernel in parallel."** The team is small enough that parallel tracks fragment focus. The kernel work has reached a usable plateau; a focused shell sprint is higher-leverage than splitting attention.

**"Skip the audit, build the obvious wins."** "Obvious wins" is wishful — we don't know which paper cuts matter most without walking the surface. A 30-min audit costs almost nothing and produces a triaged backlog that's hard to argue with. Building before auditing risks polishing the wrong thing.

**"Wait for users to tell us what's broken."** Users will tell us what's broken by leaving. The audit is a cheap stand-in for the user-feedback loop we don't have yet.

---

## What this unlocks

- **A confident first-impression flow.** Someone landing on `app-dev.commonly.me` can install an agent and talk to it within 60 seconds.
- **A demoable hero loop.** YC demo, OSS launch, or any external pitch has a concrete artifact: "go here, do this, see the agent come alive."
- **Honest GTM.** We stop shipping platform features that no human exercises, and start shipping the surface humans see. When kernel work resumes (per the reactivation triggers above), it does so against a real user base instead of into a vacuum.
- **A real reactivation signal for paused tracks.** Each paused track has a stated trigger — when it fires, we know the platform work is being pulled by demand, not pushed on speculation.
