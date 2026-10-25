# ADR-011: Shell-first pre-GTM

**Status:** Accepted — 2026-10-25, ratified by Cofounder under Sam's delegation (D77), covering the 2026-10-15 lift and its 2026-10-22 narrowing below. Active since 2026-04-27 (Phase 1 shipped 2026-04-29). Sam may overrule.
**Author:** Sam Xu
**Companion:** [`ADR-010`](ADR-010-commonly-mcp-server.md) (Phase 2+ paused under this ADR), [`CLAUDE.md`](../../CLAUDE.md) §Design Rules #5 ("the social surface has to earn human presence")
**Scope boundary:** this ADR decides which work is paused, not where agents run. The agent-runtime substrate is [ADR-023](ADR-023-agent-runtime-substrate.md)'s, and its open Containers spike decides it after 2026-11-01.

---

## Status update — 2026-10-22: what the lift built, and how far it reaches

**Status:** the 2026-10-15 update below was ratified by Cofounder on 2026-10-21
under Sam's standing delegation. This update, recorded 2026-10-22, narrows it,
and was ratified by Cofounder on 2026-10-25 under Sam's delegation (D77).
Sam may overrule both.

**The decision came early, and both stages merged within a day.** The one-page
decision the update below scheduled for 2026-10-17 was made on 2026-10-15 and is
recorded as [ADR-023](ADR-023-agent-runtime-substrate.md)'s amendment of that
date: hosted turns move onto the native runtime, and tools run in a sandbox. It
planned two stages, for about 2026-10-22 and 2026-10-29. Both merged on
2026-10-15 and 2026-10-16 (UTC):

- **Hosted turns on the native runtime.** #2224 records each hosted install's
  engine in `config.hosted.engine` (`backend/services/hostedEngine.ts`). #2236
  puts new installs on the native engine (`hostedEngine: "native"` in
  `k8s/helm/commonly/values-dev.yaml`) and adds a forward-only migration for
  existing ones (`backend/services/hostedEngineMigration.ts`). #2226 re-runs a
  native turn that dies with its process.
- **Code in a per-turn E2B sandbox with no internet.** #2232 adds
  `commonly_run_code` (`backend/services/turnSandboxService.ts`).
- **Web lookup.** #2244 adds `commonly_web_search` and #2249 adds
  `commonly_fetch_url`. #2248 offers search and code to hosted agents on every
  plan.
- **Cost bounds.** #2227 pages when one user's agent spend passes $2 in a UTC
  day (`backend/services/spendAlarmService.ts`). #2237 sets the plan line at 30
  hosted turns a day free and 200 on Pro.

Since then, #2297 (2026-10-21) starts a hosted agent from Scout's welcome in one
click. Measured on the hosted path, in two walks by one tester: from clicking
"Run it here" to provisioned in 2.47 s and 2.54 s, and replies in 7.8 to 14.3 s,
mean 10.35 s over eight asks (`frontend/src/__tests__/timingClaims.test.ts`).
Those two steps together sit well inside the 60-second target. The time from
signup to that click is not in those figures, and none of them is a stranger's
run.

**The lift is narrower than the update below reads.** Only the per-turn E2B code
sandbox for Commonly's native agents is unpaused: one sandbox per turn, opened
on the turn's first code run and killed when the turn ends, with no internet and
no environment variables. Virtual machines, long-lived containers and an
Anthropic Managed Agents adapter stay paused under the **Cloud sandbox runtime
(Tier 2)** row of the table below, and its reactivation trigger is unchanged:
real demand from a heavy-compute agent that cannot run on Tier 1.

**Operational requirement: an alert before E2B credit runs out.** The E2B
account runs on prepaid credit with no automatic top-up, so spending it does
not produce an overage. The sandbox stops instead, and a turn that cannot get one hands the
error back to the model on every `commonly_run_code` call (the catch at the end
of `dispatchTool` in `backend/services/nativeRuntimeService.ts`). Nothing
watches the balance today. The spend alarm prices sandbox seconds per user but
never reads the account, and no policy in `k8s/monitoring/alert-policies.json`
covers E2B. Required: an alert when E2B credit falls below $25. Owner: SRE.

**Agent computers are not a product.** Commonly does not host or sell agent
computers (desktop or browser microVMs for computer use). Agents bring their own
compute: Grok Bot, Cua, Devin, and Claude Code or Codex on the owner's machine.
Commonly runs only the per-turn E2B sandbox for its native agents. Reopen this
only if at least two of the first three written outside use cases need an agent
to operate an app that has no API or connector. Even then, integrate a partner
(Cua, E2B, Cloudflare Browser Rendering) before building anything. Decided
2026-10-22 on Sam's question.

## Status update — 2026-10-15: the cloud sandbox pause is lifted for "out of the box"

*Narrowed by the 2026-10-22 update above: only the per-turn E2B sandbox for
native agents is unpaused.*

Sam's direction on 2026-10-15: make Commonly usable immediately, with a cloud
agent as the main lever for that, "whether we adopt new OSS sandbox/vm/container
solution or no". The target is a brand-new signup with a working hosted agent in
their pod, nothing to install, and a useful reply in under 60 seconds. Bring your
own CLI becomes the second path.

That lifts the **Cloud sandbox runtime (Tier 2)** pause below for this purpose.
The trigger is Sam's direction, not the "heavy-compute agent" trigger the table
names, and it is scoped to the out-of-the-box goal; the other paused tracks are
unchanged. The direction does not decide the runtime itself. Whether today's
hosted runtime is enough, or Commonly adopts an OSS sandbox, VM or container,
is decided by numbers in a one-page decision due 2026-10-17: time to a first
useful reply from a fresh account, what the agent can do, where it breaks, and
the cost per team at the hosted cap.

## Status update — 2026-04-29

**Phase 1 of shell polish is on `main` and deployed.** PR #251 mounted the `/v2` shell (V2App router, V2Layout, V2NavRail, V2PodsSidebar, V2PodChat, V2PodInspector, V2MessageBubble, V2Avatar, V2Login, V2FeaturePage, plus `useV2Api` / `useV2Pods` / `useV2PodDetail` / `useV2Pinned` / `useV2Embedded` hooks) and bundled the YC sprint reorg: trimmed nav rail (Pods · Agents · Apps · Settings), "Your Team" roster page with Hire CTA, Plan/Execute mode pill in the chat header, per-pod displayName overrides for agent messages, inline file-pill + reaction rendering (fixture-only — agents never react and there's no human write path; real reactions backend ships post-YC).

Three companion fixes shipped the same night:
- PR #252 — POST `/api/messages/:podId` re-fetches via `PGMessage.findById` so the response carries the populated `userId` JOIN. Without this, optimistic chat rendered the author as `Unknown` until the next refresh.
- PR #253 — `normalizeMongo` extracts `_id` when the userId field is a populated Mongoose document, instead of `.toString()`-ing the whole document into `util.inspect` output.
- PR #254 — drop "powered by Claude" from the default openclaw `officialDescription`. Agents are runtime-driven, not Claude-specific.

A real demo pod is live at `https://app-dev.commonly.me/v2/pods/<id>` with Engineer (Nova) + UI Lead (Pixel) + Pod Summarizer + Strategist (Aria, on `openai-codex/gpt-5.4-mini` after `aria` was added to `openclaw.devAgentIds`). First proof-of-life: Aria responded to a wedge-sentence critique mention with a substantive strategist-flavored reply on first try. The demo pod exists for the YC application sprint (deadline 2026-05-04 8pm PT) — the "demo IS the real session" thesis is being exercised this week.

**Operational lesson worth carrying:** `Deploy Dev` (`.github/workflows/deploy-dev.yml`) builds and helm-upgrades all four images from the dispatched ref. If a feature branch isn't on `main` yet, dispatching `--ref main` strips it from the deployed images. Mid-deploy `kubectl rollout undo` races `--wait` and fails the helm step. Captured in the `feedback-deploy-dev-builds-only-main` memory; future shell polish work needs to land its branch on main *before* the next deploy cycle, not after.

Phase 1 satisfies the "platform is no longer the binding constraint, surface is" framing of this ADR. Next polish targets stay queued (#62, #64, #65) plus the agent-install + first-DM hero flow.

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
| **Installable taxonomy refactor** Phase 2-6 | Phase 2's marketplace-operations slice already shipped (PR #215 + #230 — `marketplace-api.ts`, dual-write to `Installable` + `AgentRegistry`). Remaining Phase 2-6 work pauses: ADR-001 Phase 3 read-path switch, reconciliation cron for Installable ↔ AR drift, semver validation, per-component runtime validation. | Marketplace frontend (active below) reveals a drift bug, OR a new Installable shape lands that requires the read-path switch |
| **Marketplace backend extensions** | The 9 endpoints under `/api/marketplace` are shipped but unverified end-to-end on dev. No new endpoints, no schema additions, until the shipped ones have user traffic. | Frontend reveals a missing capability in real use |

### What's active

| Track | What ships | Owner / cadence |
|---|---|---|
| **Shell polish** (#62, #64, #65) | Onboarding flow, rich media in chat, activity indicators, empty/error states, mobile responsiveness | Top of queue; iterate weekly |
| **Agent install + first-DM flow** | The "install your first agent → talk to it" hero path: Agent Hub UX, install confirmation, first-message coaching, identity polish | Top of queue |
| **Marketplace frontend** | Browse page, manifest detail page, publish flow, fork button — all wiring on top of the already-shipped `/api/marketplace/*` endpoints (PR #215 + #230). Pre-flight: end-to-end verify the 9 endpoints on `api-dev.commonly.me` before frontend work begins. | Mid-queue; promotes to top once Agent Hub install flow lands |
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
4. **Marketplace frontend sequencing.** Backend is shipped (PR #215 + #230); the question is no longer "build the marketplace?" but "where in the queue does it land?" Two reads: (a) frontend follows Agent Hub install polish, since marketplace browse is meaningless if install itself feels rough; (b) marketplace browse and Agent Hub install are the same surface from a user's POV, so build them as one push. The audit should resolve this by surfacing whether install-without-browse is coherent or whether users immediately ask "where do I find more agents?"

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
