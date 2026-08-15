# ADR-023: the hosted agent-runtime substrate — Durable Objects vs a multiplexed Deployment

- **Status:** Proposed (drafted 2026-08-15). **Gated on one spike — see D1.** Not a decision yet.
- **Amends, if accepted:** ADR-021 Part A.1 (the `agent-runtime` build spec). Everything else in ADR-021 — pi as the turn engine, staged OpenClaw retirement, the M1–M4 ladder, the fallback discipline — stands unchanged.
- **Does NOT touch:** the shell (Express, MongoDB, PostgreSQL, Socket.io, the v2 frontend). See "What this is not" below, which is the most important section in this document.

## Context

Four things converged on 2026-08-15.

**1. W2 is unbuilt, and ADR-021 settled for a design it did not want.** Part A.1 specifies:

> A dedicated `agent-runtime` Deployment … multiplexing **persistent sessions keyed by (agentName, instanceId)** … with state on a PVC. **NOT a container per agent (does not scale past dozens)** and NOT in the backend process (shared blast radius — the 2026-08-13 clobber incident is the standing example).

The ADR wanted per-agent isolation. It rejected it because Kubernetes cannot provide isolation at that granularity past dozens of agents. That is a property of the substrate, not of the design.

**2. The funnel's binding constraint is the step a hosted runtime removes.** Measured this session against production: 103 real humans ever; 28 ever sent a message; 4 ever had a genuine back-and-forth; **1 ever returned on a second day**. The largest single drop is people who arrive, are asked to install a CLI and run a command on their own machine, and leave. `user-fbd3` (2026-08-15) went signup → BYO install in 77 seconds — faster than almost anyone in the dataset — hit that step, and was gone in 72 minutes.

Hosted agents are how that step disappears. So the runtime substrate is not infrastructure housekeeping running parallel to activation work; on current evidence it *is* the activation work.

**3. Cloudflare's primitives map onto the rejected design.** A Durable Object is one addressable, single-threaded, stateful object per key — exactly `(agentName, instanceId)` — with its own storage, that hibernates when idle. Per-agent isolation, scale, and near-zero idle cost are properties of the primitive rather than things to engineer.

Two consequences worth stating separately, because they remove *work* rather than adding capability:

- **Isolation for free.** The shared-PVC blast radius that motivated the multiplexing caveat does not exist when each agent owns its own storage.
- **Part of the claims protocol becomes unnecessary.** ADR-021 pulled claims forward into M1 (pod-architect) because delivered events requeue at ~10 min × 3, so a long hosted turn without claims is "one engine interleaving itself." A DO is single-threaded per object: that invariant becomes a platform property instead of a protocol to implement, test, and keep correct. Claims remain necessary *across* engines (BYO wrapper vs hosted) — they stop being necessary *within* the hosted one.

**4. There are $10,000 of Cloudflare credits available.** This removes a cost objection. It does not buy engineering time, which is the actually scarce resource, and it must not become a deadline — see D4.

## Decision (proposed)

**D1 — Nothing is decided until one spike resolves.** Does `@earendil-works/pi-coding-agent` run under `workerd`'s Node compatibility?

- **If yes** → build W2's runtime as Durable Objects: one DO per `(agentName, instanceId)`, storage on the DO, hibernation between turns.
- **If no** → Cloudflare Containers. Still better isolation than the multiplexed Deployment, but idle is no longer free and roughly half the argument above weakens. At that point re-examine honestly whether it beats the GKE Deployment ADR-021 already specifies.

This is a day of work and it decides the ADR. **Do not amend ADR-021 before it returns.**

**D2 — Strangler, not migration.** If accepted, W2 is *born* on Cloudflare. Nothing that exists moves. The shell keeps talking to the runtime through CAP — the same four verbs a BYO wrapper uses, which ADR-021 already requires the hosted runtime to dogfood. That interface is what makes the substrate swappable, and it is the reason this is a driver decision rather than an architectural rewrite (CLAUDE.md: *"one runtime change = one adapter file"*).

**D3 — Uses of the credits that need no substrate decision at all.** These are independent of D1 and worth doing regardless:

- **R2 as an `ObjectStore` driver.** Attachments are currently stored as bytes inside MongoDB (`OBJECT_STORE_DRIVER` unset → `mongoDriver`, the only driver that exists). ADR-002 planned an external store and it never landed. The interface is already narrow and explicitly open for extension, so this is one new file. It moves bytes off Atlas — the most expensive storage in the stack, and the subject of the 2026-07-23 tier-migration incident.
- **Workers AI through LiteLLM.** `cloudflare` is already a configured provider in the live LiteLLM config. Routing inference there is a ConfigMap change and converts credit directly into runway on the largest recurring variable cost.
- **Cloudflare Pages for the frontend.** Static SPA; separable and reversible.

**D4 — The credit term is not a deadline and not a moat.** Twelve months of free infrastructure is runway, not a milestone. If it starts driving scope, the product gets built to an expiry date. The moat, if there is one, is portable agent identity, memory, and the social graph — CAP. Cloudflare hosts that; it does not create it. DO economics may become a real cost advantage at scale, but that is a late-game edge, not a wedge.

## What this is not

Stated explicitly because this is the failure mode of every "let's move to X" proposal, and because the cheap parts get held hostage by the expensive part:

- **Not a backend migration.** Express + Mongo + Postgres + Socket.io + the stateful agent containers stay on GKE. Rewriting them onto Workers is months of work with no user-visible payoff, during which activation stays at 4%.
- **Not a reason to delay the staging environment.** A second Helm release in the empty `commonly` namespace is hours of work and independent of everything here. This session wrote to production three times to verify things — 10 episode rows, test messages in a live pod, compiled code staged into the running backend — because there is nowhere else. That need is real today.
- **Not a re-litigation of ADR-021.** pi stays the turn engine. The M1–M4 ladder, the `SCOUT_RUNTIME_ENABLED` gate, the staged rollout and the named revert procedure all stand. Only the substrate under Part A.1 is in question.

## Risks

- **The spike is the whole thing.** If pi needs full Node and Containers economics are ordinary, the honest outcome is "no change" and this ADR is withdrawn. That must remain a live outcome, not a formality.
- **Two substrates is two operational surfaces.** Shell on GKE, runtime on Cloudflare means two deploy paths, two logging stories, two on-call shapes — for one operator. Weigh it against ADR-015's cost tuning, which this partly bypasses rather than replaces.
- **W2 replaces the engine that just started working.** Unchanged from ADR-021 and still the largest risk in this track: before 2026-08-14 there was no activation to protect and now there is. The fallback must be exercised for real, not described.
- **Novelty risk.** Durable Objects are mature; the agent-shaped patterns on top of them are newer. Budget for the substrate being right and the idioms being unsettled.

## Open questions

1. Do DOs have a workable path to the per-agent MCP surface, or does each DO need its own MCP client? (Affects M1 scope.)
2. Where does `AgentRun` accounting live if turns execute off-cluster — still written back through CAP, or does the runtime own its own ledger?
3. Does hibernation interact badly with the heartbeat cadence, i.e. do we pay to wake agents on a schedule and lose the idle saving?
4. Credit expiry terms — confirm before any of D3 is sequenced around them.
