# ADR-023: the hosted agent-runtime substrate — as built, the native runtime with tools in a per-turn sandbox

*Titled "Durable Objects vs a multiplexed Deployment" from 2026-08-15 to 2026-10-22. That comparison is kept below as Context and Decision; "As built" is what runs.*

- **Status:** **Accepted.** Ratified by Sam on 2026-08-28 under the activation goal (one stranger, unassisted, reaches a live agent conversation), selecting Durable Objects (D1–D4 below). Amended 2026-10-15 (A1–A3, ruled by Cofounder under Sam's delegation), moving hosted turns onto the native runtime; that amendment was ratified by Cofounder on 2026-10-21 under Sam's standing delegation. Rewritten as built on 2026-10-22. Sam may overrule. Acknowledged unknowns this does not settle are listed under "Open items": the substrate after 2026-11-01 (the Containers spike), per-user usage measured on hosted agents themselves, and E2B as an outside dependency.
- **Supersedes:** [ADR-021](ADR-021-pi-turn-engine-and-openclaw-retirement.md) Part A.1, the `agent-runtime` build spec. A.1's separate Deployment, PVC sessions, run-PATCH endpoint and token secret were never built; "What replaced ADR-021 A.1" below maps each item to what runs. ADR-021 Part B (OpenClaw retirement) is unaffected.
- **Scope-boundary note:** for where a hosted agent runs, read this ADR, not ADR-021 A.1. [ADR-011](ADR-011-shell-first-pre-gtm.md) decides what is paused: its 2026-10-22 update unpauses only the per-turn E2B sandbox for native agents, keeps VMs, long-lived containers and Managed Agents paused, and rules that Commonly does not host agent computers. [ADR-026](ADR-026-local-agent-daemon.md) (local agent daemon) covers users whose value proposition is LOCAL execution; this ADR is the zero-install path for everyone else, and the two are complements, not competitors.
- **Does NOT touch:** the shell (Express, MongoDB, PostgreSQL, Socket.io, the v2 frontend). See "What this is not" below.

## As built (2026-10-22)

A hosted ("Run it here") agent runs inside the Commonly backend, on the same loop as Commonly's other native agents (`backend/services/nativeRuntimeService.ts`). Code it writes runs outside the backend, in an E2B sandbox that lives for one turn. The Cloudflare Durable Object this ADR first selected (`workers/agent-runtime`) is still in the tree and configured, as the fallback engine. Every statement in this section was read from `main` at `46da417f9`.

### Which engine runs a hosted turn

- An install keeps `config.runtime.runtimeType: 'hosted'`, so the hosted cap, the entitlement gate and the hosted count still key on it. Its engine is a separate record, `config.hosted.engine` (`backend/services/hostedEngine.ts:1-19`, `:36-40`).
- A new install's engine comes from `HOSTED_ENGINE` (`hostedEngine.ts:103-107`), which `k8s/helm/commonly/values-dev.yaml:60-64` sets to `native`; empty keeps the Durable Object. The install route writes `config.hosted` itself and drops any client-sent copy (`backend/routes/registry/install.ts:569-576`).
- `AgentEventService.resolveInProcessInstallation` (`backend/services/agentEventService.ts:1264`) returns the install when it is `native`, or hosted, on the native engine and provisioned (`:1302-1326`; `hostedRunsNative`, `hostedEngine.ts:128-132`). Such an event is created already claimed and run fire-and-forget by `dispatchInProcess` (`agentEventService.ts:1333`, `:1470`). Nothing polls for it.
- A hosted agent answers only `chat.mention` and `first_contact`, the two event types the Durable Object handled. Any other event is acked without a model call (`hostedEngine.ts:140-152`, `nativeRuntimeService.ts:1353-1361`).
- A turn that dies with the backend process is re-run from the event sweep, claimed by swapping its delivery nonce (`AgentEventService.redispatchStuckInProcess`, `agentEventService.ts:919`; #2226). The backend is pinned to the on-demand pool, not spot (`values-dev.yaml:41-52`), so the restarts this covers are deploys and crashes.

### What a hosted turn runs with

- A configuration built on the server and never taken from the install, because a hosted install's stored config came from the browser (`hostedNativeRunConfig`, `hostedEngine.ts:266-288`). It carries the system prompt, nine tools (`HOSTED_NATIVE_TOOLS`, `:167-177`), the pod's last 8 messages (`:180`) and the owner's plan line as the daily cap. The model is left unset, so the turn runs on the runtime default through LiteLLM: `LITELLM_CHAT_MODEL`, else `deepseek-v4-flash` (`nativeRuntimeService.ts:87`). The person cannot choose another model.
- No session state. Continuity is the recent messages each turn reads, plus the agent's memory tools.
- No runtime token. Every mint path refuses an agent Commonly runs in-process, with 409 `in_process_agent_no_token` (`backend/routes/registry/tokens.ts:227-243`), so nothing outside the backend can act as it.
- Connector broker tools are added per run and fail closed (`nativeRuntimeService.ts:1717-1730`).
- The tool gate holds at dispatch. The loop refuses any tool it did not offer in that model call (`nativeRuntimeService.ts:1959-1963`), and once web text is in the turn only in-pod tools and further lookups remain (`:643-648`, `:498`).

### What leaves the process

- **Code, in E2B.** `commonly_run_code` opens one sandbox on the turn's first call and kills it when the turn ends, whatever happened (`backend/services/turnSandboxService.ts:71-90`, `:120-130`; closed at `nativeRuntimeService.ts:2113-2118`). The template is pinned (`code-interpreter-v1`, `:22`). The sandbox has no internet (`allowInternetAccess: false`), no public inbound (`allowPublicTraffic: false`) and no environment variables (`:76-86`). It runs Python or JavaScript, at most 5 runs a turn of 30 s each, with a 3-minute lifetime as the backstop if the kill fails (`:23-30`). The tool is offered only when the instance holds `E2B_API_KEY` (`:32`; `nativeRuntimeService.ts:467-476`), which Helm sets only under `hostedSandbox.enabled` (off in `values.yaml`, on in `values-dev.yaml:11-15`).
- **Web search,** Exa by default and Tavily by setting (`backend/services/webSearchService.ts`), at most 3 a turn (`nativeRuntimeService.ts:499`). It is called from the backend, not from the sandbox.
- **Reading a page.** `commonly_fetch_url` opens only an address that appears in text the turn was given (`backend/services/webAddressProvenance.ts`), at most 3 a turn (`nativeRuntimeService.ts:503`).

### Limits and cost

- Per turn: 10 model rounds and 60 s of wall clock (`nativeRuntimeService.ts:75-77`), plus the tool limits above.
- Per hosted install per day: 30 turns free and 200 on Pro (`backend/services/hostedRuntimeService.ts:36-39`, `:57-61`, `:80`), enforced as the native per-install cap, which fails open (`nativeRuntimeService.ts:1382-1416`). The first-contact greeting does not count.
- Per user per day, across all their agents: 120 runs, 300 on Pro, failing closed (`nativeRuntimeService.ts:1418-1467`).
- Every turn writes an `AgentRun` (`nativeRuntimeService.ts:1544-1558`), with `sandboxSeconds`, `webSearches` and `webFetches` (`:2113-2127`).
- The spend alarm prices each user's day (model tokens, sandbox seconds and searches) and pages past $2 (`backend/services/spendAlarmService.ts`; policy in `k8s/monitoring/alert-policies.json:380`). It reports and never blocks.
- Not built: an alert on the E2B account's credit. ADR-011's 2026-10-22 update makes it a requirement (below $25, owner SRE).

### The Durable Object, now the fallback

- `workers/agent-runtime` is still in the tree, and the backend is still configured to reach it (`values-dev.yaml:79-80`). It runs any hosted install that is not on the native engine, and every new one if `HOSTED_ENGINE` is emptied.
- The migration off it is forward-only, with no rollback (`backend/services/hostedEngineMigration.ts:1-10`, run by `backend/scripts/migrate-hosted-to-native.ts`). So the fallback A1 describes holds for new installs only: a migrated install has no scripted way back.
- Its turn engine is pi agent-core (`workers/agent-runtime/src/turn.ts`). The backend has no pi dependency, so hosted turns on the native engine do not run on pi. pi otherwise survives as a bring-your-own wrapper adapter (`cli/src/lib/adapters/pi.js`).
- Retiring it is not scheduled here.

### What replaced ADR-021 A.1

| A.1 specified | As built |
|---|---|
| A new top-level `agent-runtime` Deployment on the dev pool, with a PVC and no public ingress | Not built. Hosted turns run in the backend process. |
| Transport: the CAP event queue, polled per hosted agent with its own token | Events are claimed at creation and run in-process. Only the Durable Object fallback polls CAP. |
| A pi session per `(agentName, instanceId)`, persistent on the PVC, LRU-hydrated | No session state: recent messages and memory tools, each turn. |
| `AgentRun` created by the scheduler and closed by the runtime through `PATCH /api/agents/runtime/runs/:runId` | The native runtime creates and closes the row in-process. No such route exists. |
| Per-agent runtime tokens in an `agent-runtime-tokens` secret | None. An agent Commonly runs in-process cannot hold a runtime token. |
| Failure: flip `HOSTED_RUNTIME_ENABLED`, no deploy | `HOSTED_ENGINE` picks the engine for new installs; existing installs keep the engine recorded on them. |

### Known costs of the build

- **A shared process.** ADR-021 Part A kept hosted turns out of the backend for blast radius; as built puts them in it. Model calls wait on the network, but anything a turn computes runs on the API's event loop. The review of #2249 measured a quadratic trim that would have let three hostile pages block that loop for 7.2 s in one turn; it was fixed before merge. Each new in-process tool needs the same review.
- **E2B is an outside dependency** with no provider-side spending cap, and the account runs on prepaid credit with no automatic top-up. Running out of credit stops the sandbox; ADR-011's requirement is the alert before that.

### Open items

1. **The Containers spike decides the substrate, after 2026-11-01.** As built was chosen for the out-of-the-box goal, not as the long-run substrate. The spike asks whether hosted agents should move to a container per agent (Cloudflare Containers was D1's named alternative), for isolation and longer work, against the in-process loop's lower cost. Until it reports, nothing here commits Commonly to VMs or long-lived containers, which ADR-011 keeps paused.
2. **Per-user usage, measured on hosted agents.** A3's figures used Scout as a proxy. Hosted turns now write `AgentRun` rows, so re-measure from them two weeks after Stage 2 merged, on or after 2026-10-30.
3. **The E2B credit alert** (ADR-011, owner SRE).
4. Retiring the Durable Object, and whether pi returns as a hosted engine. Neither is scheduled.

## Amendment, 2026-10-15: hosted turns run on the native runtime, and tools run in a sandbox

- **Status:** **Accepted** 2026-10-15, ruled by Cofounder under Sam's delegation; Sam may overrule. Acknowledged unknowns this does not settle: per-user usage was measured on Scout as a proxy, because hosted agents write no run records yet (re-measured two weeks after Stage 2); how hosted turns behave under a spot-node reclaim; and E2B as an outside dependency.
- **Scope-boundary note:** [ADR-011](ADR-011-shell-first-pre-gtm.md) paused the Tier 2 cloud sandbox. Its 2026-10-15 status update lifts that pause for the out-of-the-box goal only, and A2 below depends on that lift. [ADR-026](ADR-026-local-agent-daemon.md) (local execution) is unchanged.

**Why.** W2 shipped as D1 selected: one Durable Object per hosted agent. Measured from a fresh account on 2026-10-15, it is fast (agent ready 26 s after signup, first useful reply about 10 s later) and honest, but its only tool reads pod context. It has no web, no code, no files, no connectors and no run records. It answered one of four basic asks (summarize the pod) and declined web lookup, running a script and reading a repo. Making it useful needs the connector broker, an `AgentRun` per turn, the per-user daily ceiling ([ADR-022](ADR-022-persona-colleagues.md) D5), the tool gate and the connector eligibility rule. `nativeRuntimeService` already has all five; the Durable Object has none.

**A1. Hosted turns run on `nativeRuntimeService`** (Stage 1, about 2026-10-22). A `runtimeType: 'hosted'` install answers through the native loop, with DeepSeek through LiteLLM, so the platform fallbacks apply. It sits behind a per-install flag, and the Durable Object stays as the fallback until the native path reaches parity, then retires. This narrows D2: hosted agents move instead of the runtime being strangled in place, because the one-loop rule (CLAUDE.md design rule 6) outweighs keeping a second loop that would need the same five features.

**A2. Tools run in an E2B sandbox** (Stage 2, about 2026-10-29). Each turn gets one Firecracker microVM, stopped when the turn ends so there is no idle billing. Outbound traffic is limited to listed hosts, and credentials come from the broker, never the prompt. Web lookup goes through the same egress path or a search API, whichever costs less per turn.
- **Rejected:** the Cloudflare Sandbox SDK runs inside Workers, so the backend would need a proxy, and a sandbox left idle bills memory for 10 minutes. gVisor on our own cluster needs warm slots we would run, with no TypeScript SDK. Daytona shares the host kernel by default and has been closed source since June 2026.
- **The exit:** E2B's runtime is Apache-2.0 and can be self-hosted.

**A3. Cost is recorded and bounded.** Every hosted turn writes an `AgentRun`, and an alarm fires when any one user passes $2 in a day. The plan line ships with tools: 30 turns a day for free or individual, 200 for team or paid. DeepSeek stays the default, and a premium model is a paid add-on.
- **Measured on 2026-10-15,** on DeepSeek V4.1-Flash at $0.30/$1.20 per million tokens, with Scout runs averaging 5,468 tokens: about $1–2.30 per user a month at the 90th percentile of use, and at most $6.70 at the 30-turn cap.
- **The 200-turn cap is the tail,** at $14–44.
- **The model sets the price, not the sandbox:** about $0.0004 per 20-second turn on E2B.

**What shipped, and where it differs from the text above** (see "As built" for paths):
- **A1** merged on 2026-10-15 and 2026-10-16 (#2224, #2236, #2226), a week before its date. The fallback is narrower than written: the migration off the Durable Object is forward-only, so only new installs can fall back.
- **A2** merged on the same two days (#2232, #2244, #2249, #2248), two weeks early. The sandbox is stricter than written: no outbound traffic at all rather than listed hosts, and no credentials inside it. Web lookup is a search API and a page reader called from the backend, not traffic from the sandbox. A turn that runs no code opens no sandbox.
- **A3** merged (#2227, #2237). The plan line is 30 turns a day free and 200 on Pro, keyed on the owner's `entitlements.pro`. A premium model as a paid add-on is not built: a hosted agent runs on the default model only.
- **The spot-reclaim unknown** in the status line above no longer applies as worded: hosted turns now run in the backend, which is pinned to the on-demand pool. A restart mid-turn is covered by #2226.

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

**4. There are $10,000 of Cloudflare credits available, and they are substantially the runway.** Commonly is unfunded — no raise, no YC (F26 declined, on wedge rather than engineering). Infrastructure is paid out of pocket. So these credits are not a discount on a budget; for practical purposes they are the budget, and their term is a real clock rather than an accounting detail. What they do not buy is engineering time, which is the other scarce resource and the one no credit covers. See D4, which is where the economics actually live.

## Decision (drafted 2026-08-15, ratified 2026-08-28)

*As of 2026-10-22: D1's Durable Object design shipped as W2 (`workers/agent-runtime`) and is now the fallback engine. A1 supersedes D2's "nothing that exists moves": hosted agents moved. D4's economics assumed Durable Object hibernation and inference on Workers AI credits; hosted turns now run on paid DeepSeek inference through LiteLLM, so A3 carries the cost model. D3, and D4's two obligations, stand as written.*

**D1 — Nothing is decided until one spike resolves.** Does `@earendil-works/pi-coding-agent` run under `workerd`'s Node compatibility?

- **If yes** → build W2's runtime as Durable Objects: one DO per `(agentName, instanceId)`, storage on the DO, hibernation between turns.
- **If no** → Cloudflare Containers. Still better isolation than the multiplexed Deployment, but idle is no longer free and roughly half the argument above weakens. At that point re-examine honestly whether it beats the GKE Deployment ADR-021 already specifies.

This is a day of work and it decides the ADR. **Do not amend ADR-021 before it returns.**

**D1 resolved YES on 2026-08-22.** Spike evidence (run locally under workerd via `wrangler dev --local`, `nodejs_compat`, pi 0.84.2): `@earendil-works/pi-agent-core` — the turn engine: `Agent`, `AgentHarness`, compaction, 106 exports — **loads AND constructs inside workerd.** Three findings that de-risk the DO design beyond the yes/no:
1. The package quarantines its Node half behind a separate `./node` export (fs sessions, child_process, readline live there and only there — verified by builtin survey of the dist graph). The default entry the worker imports never touches them.
2. The engine's LLM transport is dependency-injected (`streamFn`; construction without one fails with the engine's own validation error, not a compat error). Fetch-based transport, no Node HTTP binding — exactly the shape a DO provides.
3. Construction with a stub transport succeeds end-to-end: `{ loaded: true, exports: 106, constructed: true }`.

Per D1's own text, the resolution selects: **build W2's runtime as Durable Objects** — one DO per `(agentName, instanceId)`, sessions on DO storage (replacing the `./node` fs half), tools as CAP calls. Spike artifacts: `worker.js` + `wrangler.toml`, reproducible in ~5 minutes. Acknowledged unknown carried into that build: D4's credit-term economics remained estimates, not measurements.

**D2 — Strangler, not migration.** If accepted, W2 is *born* on Cloudflare. Nothing that exists moves. The shell keeps talking to the runtime through CAP — the same four verbs a BYO wrapper uses, which ADR-021 already requires the hosted runtime to dogfood. That interface is what makes the substrate swappable, and it is the reason this is a driver decision rather than an architectural rewrite (CLAUDE.md: *"one runtime change = one adapter file"*).

**D3 — Uses of the credits that need no substrate decision at all.** These are independent of D1 and worth doing regardless:

- **R2 as an `ObjectStore` driver.** Attachments are currently stored as bytes inside MongoDB (`OBJECT_STORE_DRIVER` unset → `mongoDriver`, the only driver that exists). ADR-002 planned an external store and it never landed. The interface is already narrow and explicitly open for extension, so this is one new file. It moves bytes off Atlas — the most expensive storage in the stack, and the subject of the 2026-07-23 tier-migration incident.
- **Workers AI through LiteLLM.** `cloudflare` is already a configured provider in the live LiteLLM config. Routing inference there is a ConfigMap change and converts credit directly into runway on the largest recurring variable cost.
- **Cloudflare Pages for the frontend.** Static SPA; separable and reversible.

**D4 — The credits are not a cost saving. They are what makes the activation fix affordable at all.**

An earlier draft of this ADR said "twelve months is a credit term, not a deadline." That is advice for a funded company and it is withdrawn. Unfunded, the term is the clock.

The economics that matter are not the infrastructure bill. They are per-user, and they run backwards:

- **BYO costs ~$0 per user and does not activate.** The user brings their own compute. It is also the step the funnel dies on: 103 real humans, 28 ever typed, 4 ever had a genuine exchange, 1 ever returned.
- **Hosted activates and costs money per user.** Every hosted agent is inference we pay for. For an unfunded company that is the wrong shape by construction — the better it works, the faster it burns.

That tension is the real reason the substrate matters, and it is not "GKE is expensive." Durable Objects hibernate when idle; Workers AI runs on the credits. Together the marginal cost of a hosted agent is approximately zero for the credit term. **The "remove the CLI step" experiment is not affordable on GKE without funding, and is affordable on credits.** That is the argument. Cheaper infrastructure is a rounding error beside it.

Two obligations follow, and they are conditions of accepting this ADR rather than notes:

1. **Pricing ships with hosted agents, not after them.** *Status 2026-08-30: the metering floor shipped with the self-serve surface (`/api/hosted`; per-user agent cap + per-agent daily turn cap enforced in the kernel, see `docs/runbooks/hosted-agent-provisioning.md`). Charging against credits remains open.* Free-during-beta on credits is coherent only if something charges before the term ends. An ADR section on metering belongs in the W2 work, not in a later document.
2. **Spend credits toward a returning user, not toward completeness.** The credits reward using Cloudflare; they do not reward using it for everything. Rebuilding what already works consumes the term without moving the number that ends the company.

**Unchanged from the earlier draft: the moat is not Cloudflare.** It is portable agent identity, memory, and the social graph — CAP. Cloudflare hosts that; it does not create it. DO economics may become a genuine cost advantage at scale, but that is a late-game edge, and YC declined this on wedge.

## What this is not

Stated explicitly because this is the failure mode of every "let's move to X" proposal, and because the cheap parts get held hostage by the expensive part:

- **Not a backend migration.** Express + Mongo + Postgres + Socket.io + the stateful agent containers stay on GKE. Rewriting them onto Workers is months of work with no user-visible payoff, during which activation stays at 4%.
- **Not a reason to delay the staging environment.** A second Helm release in the empty `commonly` namespace is hours of work and independent of everything here. This session wrote to production three times to verify things — 10 episode rows, test messages in a live pod, compiled code staged into the running backend — because there is nowhere else. That need is real today.
- **Not a re-litigation of ADR-021.** pi stays the turn engine. The M1–M4 ladder, the `SCOUT_RUNTIME_ENABLED` gate, the staged rollout and the named revert procedure all stand. Only the substrate under Part A.1 is in question.
  *(2026-10-22: as built, hosted turns do not run on pi, and no `SCOUT_RUNTIME_ENABLED` or `HOSTED_RUNTIME_ENABLED` gate exists in the code; see "As built". This ADR still does not rule on ADR-021 Part A's choice of pi.)*

## Risks

- **The spike is the whole thing.** If pi needs full Node and Containers economics are ordinary, the honest outcome is "no change" and this ADR is withdrawn. That must remain a live outcome, not a formality.
- **Two substrates is two operational surfaces.** Shell on GKE, runtime on Cloudflare means two deploy paths, two logging stories, two on-call shapes — for one operator. Weigh it against ADR-015's cost tuning, which this partly bypasses rather than replaces.
- **W2 replaces the engine that just started working.** Unchanged from ADR-021 and still the largest risk in this track: before 2026-08-14 there was no activation to protect and now there is. The fallback must be exercised for real, not described.
- **Novelty risk.** Durable Objects are mature; the agent-shaped patterns on top of them are newer. Budget for the substrate being right and the idioms being unsettled.
- **The cliff at the end of the credit term is real and dated.** Zero marginal cost is a property of the credits, not of the architecture. If hosted agents work and nothing charges before the term ends, the reward for succeeding is a bill with no revenue behind it — a worse position than today, because by then users depend on it. This is why D4 makes pricing a condition rather than a follow-up.
- **Opportunity cost is the largest risk in this ADR and it is not technical.** Twelve months spent on substrate arrives at month twelve with better architecture and the same 4%, and the same wedge YC already declined. Every week here has to be defensible as the fastest available path to a second returning user, or it is the wrong week.

## Open questions (2026-08-15)

*Status 2026-10-22: 1 and 3 are moot for the native engine, whose tools run in-process and whose hosted agents answer only mentions and first contact. 2 is answered: the native runtime writes the `AgentRun` in-process. 6 is partly answered by the plan line (#2237). 4 and 5 stay open. The open items that decide what comes next are under "As built".*

1. Do DOs have a workable path to the per-agent MCP surface, or does each DO need its own MCP client? (Affects M1 scope.)
2. Where does `AgentRun` accounting live if turns execute off-cluster — still written back through CAP, or does the runtime own its own ledger?
3. Does hibernation interact badly with the heartbeat cadence, i.e. do we pay to wake agents on a schedule and lose the idle saving?
4. Credit expiry terms — confirm before any of D3 is sequenced around them.
5. **What is the current monthly burn, and what dominates it — GKE, Atlas, or inference?** Nobody has put the number in a document. Every economic claim in D4 changes shape depending on it, and it is the one input here that is known to the operator and to no one else.
6. What charges, and when? D4 makes this a condition of acceptance; it does not answer it. ADR-022's allowance work and the existing pricing model are the obvious inputs.
