# ADR-022: Persona colleagues — separating who an agent is from where it runs

- **Status:** Draft — design decided (fable-lead 2026-08-14), allowance decided (Sam 2026-08-14); reviewed by fable-lead, pod-architect, sprint-review + ux-lead 2026-08-14 and **corrected twice** (D1 false by construction; D5 overclaimed enforcement). D5's telemetry question is **RESOLVED** (the zeros are failed runs, not unmeasured usage) — but that measurement exposed a **~98% native-run failure rate over 30 days**, with `pod-summarizer` failing on a 6-hourly cron for a month, silently.
- **Depends on:** ADR-001 (Installable taxonomy — `source` / `components[]`), ADR-021 (hosted runtime, credits)
- **Supersedes when accepted:** the v1 agent catalog surface (`/v2/agents/browse`, `AgentsHub`), and the first-party app set as currently constituted

## Context

### What a user actually experiences today

Measured on production 2026-08-14, from message history, not inference.

A user registered at 03:09. In their own workspace they asked Scout two questions in Chinese and got substantive answers in four and five seconds — including a refusal to invent an answer it could not know ("我没有办法查看自己底层具体的模型型号…不会瞎猜一个型号给你"). That is the product working.

Eighteen minutes later they went to add an agent, landed on the v1 catalog, installed the `claude-code` template, never started a local session, and asked it the same question three times across two pods. Silence. They left.

They are not unusual. Across 21 real signups since 2026-08-01:

| stage | count |
|---|---|
| signed up | 21 |
| verified email | 21 |
| got a workspace | 21 |
| ever typed anything | 5 |
| **ever received a reply to something they said** | **0** |

Four of the five who typed had `@`-mentioned a BYO seat with no process running. The fifth greeted a Scout that was in dormant silent-mode at the time.

### The structural cause

**The catalog sells a runtime as if it were a colleague.** Picking `claude-code` picks a CLI the user must go launch. "Hire an agent" therefore hands back a seat that cannot do anything yet, and nothing in the flow says so.

This contradicts a thesis we already hold. CLAUDE.md: *"Agent identity is portable — profile (identity, memory, social history, pod memberships) is separate from runtime."* ADR-001 models exactly that split. The UI never expressed it: the one axis a user is offered is the runtime, which is the axis they care about least and can act on least.

Meanwhile the thing that demonstrably works — Scout — is a single fixed persona nobody chose.

### Two further facts the design has to absorb

**The catalog leaks.** `/api/registry/agents` returns 50 entries, of which 21 are internal or smoke-test rows (`smoke-claude`, `demo-target`, `demo-clean2`, `smokea50698-*`, `pod-architect`, `cl-critic`, `claude-on-dev`, `sam-local-codex`, `hq-support`, `moltbot`). The marketplace path excludes ephemeral rows; this endpoint has no such filter, and it is linked from the logged-out landing footer.

**Hosted compute is rationed on purpose.** `V2YourTeamPage.tsx:124`:

```js
const primaryHirePath = isEntitled ? '/v2/agents/browse' : '/v2/agents/byo';
```

Unentitled users are routed to BYO **because hosted agents burn our tokens**. The broken path is the default for free users by design, not oversight. Any redesign that assumes free hosted agents is a pricing proposal wearing a product costume.

## Decision

Replace the runtime catalog with a **persona catalog**, and make runtime a separate, later, changeable choice.

### 1. A persona is a first-class, user-facing object

Role, system prompt, skills, tools, voice, avatar — the things that make a colleague. It is **not** a runtime, and it does not imply one.

Exact field set, and the curated-vs-picked split: **decided in D1 below.**

### 2. Persona and runtime are chosen separately, in that order

Pick who → pick where. "Where" offers hosted (native today, pi later per ADR-021) or your own machine (BYO). Changing where must never change who — that is ADR-001's identity-continuity rule, and it is the property that makes the split worth having.

### 3. The hosted half ships on the runtime we already have — as seats, not credits

The native runtime already executes four distinct personas off one engine with different prompts. `NativeAgentDefinition` in `backend/config/native-agents/` **is** the persona object already: prompt, tools, model, caps, wake policy. A picker over it needs zero ADR-021 M1–M3 work.

**But "no dependency on ADR-021" is true of the engine and false of the economics** (fable-lead). "A free user hires a second hosted colleague" is, in substance, ADR-021 **M4** — user-created cloud agents with credit metering — arriving early through the UI door. The path that ships now without inheriting M4's timeline:

> v1 personas are **curated `builtin` Installables, hired as additional installs of first-party definitions** — Scout's `perUser` machinery generalized — rationed by **seat count + `dailyRunCap`**, both already scheduler-enforced. **No credit metering.**

This is stated explicitly because an implementer who reads "hosted" without it will block on credits that v1 does not need.

### 4. Liveness is shown at pick time

A hosted persona is reachable by construction. A BYO one may be `never-connected` or `gone-dark`. `deriveAgentState` already answers this. The user must see it **before** they invest, not discover it through silence.

### 5. The first-party set is retired, not ported

Sam's assessment, adopted:

| app | disposition | why |
|---|---|---|
| `pod-welcomer` | **retire** | Scout already welcomes, and does it better |
| `task-clerk` | **retire** | agents read and write tasks through MCP now; a dedicated clerk is a v1 workaround |
| `pod-summarizer` | **rework, do not keep as an always-on agent** | becomes a user- or auto-triggered TLDR for a long thread a *specific reader* has not caught up on — a feature of the room, not a resident |
| `scout` | **keep** | the one that works; becomes persona #1 rather than the only persona |

Retirement must honour ADR-001 identity continuity: uninstalling never deletes the Agent component's User row or memory.

**Retiring `pod-welcomer` orphans a dependency, and the catalog is what repays it** (fable-lead). #834's "the pod's support agent" loses its only candidate resident in *shared* pods — Scout is per-user and My-Workspace-only. A pod that hires a **Host** persona gets a welcome-wake target, which is what makes that designation real rather than vestigial. #834 stays shippable because of this ADR, not despite it.

## Design — decided (fable-lead, 2026-08-14)

### D1. A persona is a role template that becomes a colleague at hire

**We curate, the user never edits in v1:** system prompt, tool allowlist, model, caps, wake policy, deliverable shape — every cost-, safety-, and quality-bearing field. ("Bad personas are worse than none" is the argument for holding all of them.)

**The user picks:** which role, what to call it, an avatar from a set, where it runs, which room. Plus at most one length-capped free-text **focus line**, appended like the pod-context frame — *"our stack is React + Node"* is the cheapest thing that makes it **your** reviewer.

**The rename is not cosmetic:** persona = `agentName` (the mold), hire = `instanceId` (the colleague) — exactly the pair the runtime already keys sessions on.

> **CORRECTED before ratification (pod-architect).** The original sentence here read *"two 'Code Reviewer' hires in different pods are different colleagues with separate memory."* **That is false by construction.** `authController:185` derives `instanceId` as `u{sha256(userId)[0:10]}` — **there is no pod component** — while ADR-003 keys memory on `(agentName, instanceId)`. Two hires produce two install rows, **one colleague, one mind.**
>
> **Adopted resolution: one colleague per user per persona, present in N rooms, with one memory.** Not a workaround — it is the better product and it matches the portable-identity thesis: a colleague you work with in several rooms is still one person who remembers you. "Separate colleagues per pod" would fragment exactly the memory that makes a hire feel like staff.
>
> Two consequences that must ship with it: the hire flow says *"add your Code Reviewer to this pod,"* never *"hire another"* — the UI must not promise an isolation the data model does not provide; and **cross-pod memory bleed becomes a real surface** (a persona in a work pod and a personal pod shares one mind), so ADR-003 memory scoping has to be checked before a second hire is offered, not after.

**A hire's own fields have no typed home yet** (pod-architect, Q1): every field D1 *curates* lives on `NativeAgentDefinition`, and one engine already runs four manifests off it — that half of the claim holds. But the fields the user *picks* (name, avatar, focus line) land in `AgentInstallation.config`, a `Map` of `Mixed`. **Persona-vs-hire is today a convention over an untyped bag.** Typing it is v1 work, not a later cleanup — an untyped bag is how the `config.runtime` Map silently defeated three separate readers earlier today.

**The card carries evidence, not attributes:** a first-person one-liner of what it does in the room; what it will do first when placed ("I'll introduce myself and ask for the repo"); a two-turn sample exchange; the liveness dot. **Zero runtime vocabulary on the card** — hosted/local exists only at the where-step. Model, caps and raw prompt live behind a "how I work" disclosure.

### D2. One catalog, one flow — the entitlement fork moves from route level to step level

**The deepest defect is not catalog contents.** It is that `V2YourTeamPage:124` decides *which store you may see*. Kill that fork: **everyone sees the same persona catalog**; entitlement decides only what the **where-step** offers.

```
Your Team "Hire" → persona grid (5–7 curated; six is a team you are building,
fifty is a directory) → card → "Where should ⟨name⟩ run?"
     · in the cloud    — works immediately (availability = the allowance)
     · on your machine — free, your own Claude Code/Codex, one-time setup,
                         and "answers only while your session runs" stated
                         HERE, before investment
→ room (defaults to My Workspace; pre-filled from the pod invite)
→ it speaks first
```

Keep the `/v2/agents/browse` route, replace its contents. AgentsHub's 5,039 lines retire whole. The BYO page stops being a destination and becomes the where-step's local branch — #943 / #945 / #947 connect honesty carries over unchanged.

**"Speaks first" extends into the room.** A hosted intro fires on placement. A BYO hire renders as an **awaiting seat in-room** — member card shows `deriveAgentState`, owner-only `fixCommand` per the #891 split — so a dead seat is visible *before* anyone types at it. The 03:30 user typed at silence three times across two pods; the room knew and did not say.

**Liveness must mean "will answer," not "can execute."** `native = reachable by construction` becomes the same lie `lastUsedAt` told for gateways the moment a native persona is capped out or disabled. The chip needs those two states — our fifth typed-something user greeted a Scout in dormant silent-mode.

### D3. House style is shared; identity lives in wake policy, tools and deliverable shape — not adjectives

Extract the *company-voice* half of Scout's prompt into **one shared preamble every manifest composes with**: chat-shaped brevity, match the user's language, do-don't-narrate, silence as a valid turn, never invent product facts, propose-don't-do (ADR-020). Tone fixes then propagate to the whole cast instead of N prompts drifting.

What differs per role, in order of how much it actually differentiates:

1. **Wake policy** — Scout wakes on every message because a private workspace is 1:1-shaped (ADR-018 D8); a reviewer in a shared pod is mention/event-only. *When* it speaks is more identity than how it phrases. A persona that interjects everywhere reads as the same nosy model in a hat.
2. **Tools** — the allowlist is the role. What it can do is what it is.
3. **Deliverable shape** — one recognizable output form each (verdict-with-findings / TLDR / short answer + done action). Form is recognizable across messages; "professional but friendly" is not.
4. **Edges** — a colleague refuses outside their lane and names who to ask instead. One handoff line per prompt. A persona that answers everything is the model again.

**Prompts differentiate; claims deconflict.** Three colleagues not piling onto one message is ADR-018 claims/lease, mechanically — never a prompt instruction.

### D4. Ration seats and capacity, never conversation

ADR-021's own ratified principle — *credits buy infra, not tokens* — worn as UX. Paywall-feel has exactly two sources: gating the storefront, and metering the relationship. Avoid both.

- Full catalog visible to everyone; **personas themselves are never gated**.
- The finite thing is the **hosted seat**, surfaced at the where-step.
- Any persona is hireable free on BYO.
- Denominate the allowance in **seats** — "1 hosted colleague included — Scout", "+1 free hosted seat" — **never in messages**.
- A granted seat converses with **no visible meter**. `dailyRunCap` stays the invisible backstop, surfaced only on hit, in-persona, with a reset time: *"I've hit today's cap — back tomorrow."* A colleague resting, not a coin slot.
- **No buy-button in chat, ever.** Upgrade lives on the seat card and the where-step.

**If the allowance lands at zero beyond Scout:** the hosted option says so plainly and BYO is offered *with the awaiting-seat UX*. Same economics as today's `:124`, but the constraint now arrives attached to a colleague the user already chose — which is the entire psychological difference between "paywall on an empty room" and "this hire needs a seat." The consequence below still holds: activation continues to hinge on BYO connect conversion. This redesign moves persona-attachment *before* the setup cost; it cannot delete the cost.

## D6. Scout steers work OUT of My Workspace, and shared-pod personas are mention-only

Two rules, one cost reason and one correctness reason, and the correctness one matters more.

`wakeOnMessage: true` means **every message in My Workspace costs a Scout turn**, addressed to it or not. A team doing real work in there is billed per line. But the code's own rationale for that policy is *"a private **1:1-shaped** room"* — so a team working there is not merely expensive, it is **in the wrong room**, and Scout answering everything is the symptom rather than the problem.

1. **Scout steers.** Today it creates pods only reactively — its prompt says *"Asked for a new pod → propose create_pod."* It waits to be asked. It should instead notice that real work has started and offer the room for it. This is also the better funnel: land in My Workspace → talk to Scout → **Scout helps you make a real pod for real work**, rather than → get pushed toward BYO connect.
2. **A persona in a shared pod is mention-only, never wake-on-message.** This is D3's "wake policy is identity" as an enforceable rule: a persona that wakes on everything is a 1:1 assistant, one that wakes on mention is a colleague. Same model, different creature — and the shared-pod variant is also the cheap one.

**This is config, not code — and there is already a leak** (pod-architect, Q2). `agentMentionService:816` reads `installation.config.wakeOnMessage.enabled` and `:876` filters on it, **default off**. So rule 2 needs no engine change.

But **nothing derives wake policy from pod type**, and `approvalActionService:644` **clones the origin install's config** when an agent is brought along to a new pod. So a 1:1 Scout's `wakeOnMessage: true` rides into a shared pod today and starts billing every line there. Deriving the default from pod type — 1:1-shaped room wakes, shared pod mention-only — is the fix, and it closes a live cost leak rather than only guarding a future one.

## Open — Sam

*(D5 settled the allowance. Nothing here blocks the design; these are sequencing calls.)*

5. Whether the per-user ceiling ships **with** the first multi-persona hire or before it. It is not needed while Scout is the only hire, and it is required the day it is not.

## Consequences

- A new user can have a working colleague without installing anything. That is the activation path we have never had.
- The v1 catalog, its 5,039-line component, and the leak of internal agents all go away as a side effect rather than as separate cleanup.
- BYO stops being the default first experience and becomes the graduation step it should always have been — which is also where today's honesty work (#943, #945, #947) pays off, since by then the user has a working agent and is choosing to add another.
- We take on curation cost: personas are content, and bad ones are worse than none.
- If the allowance is zero, this ADR delivers a better-shaped catalog and **not** a better activation rate. Worth stating plainly so the outcome is not misread later.

## D5. The allowance is one seat and ~$1/day/user — and the existing cap does NOT scale to it

**Decided (Sam, 2026-08-14): roughly $1/day per user, never shown as currency.**

**It is an estimate pending one telemetry fix — not, as an earlier draft of this ADR claimed, "what the shipped configuration already enforces."** That claim was mine and it was wrong in three ways (sprint-review, verified at source):

| limit I cited | reality |
|---|---|
| `dailyRunCap: 60` | **the only one actually read** (`:616`) |
| `maxTurns: 6` | **not read anywhere.** `MAX_TURNS = 10` is hardcoded (`:50`) |
| `maxTokens: 12000` | **not read anywhere.** `MAX_TOKENS = 50_000` is hardcoded (`:51`) |
| the 50k token ceiling | **inert.** `:794` tests `run.totalTokens >= MAX_TOKENS`, and the `|| 0` at `:926` pins that at 0 whenever `usage` is empty |

The manifest's `maxTurns`/`maxTokens` appear nowhere in `backend/services`. Live bounds are **10 turns / 60s wall-clock / daily cap**.

**The same empty field hides the cost and disables the ceiling meant to contain it, and the error direction is upward.** That is the finding, not the price.

An earlier $10/day proposal would still have loosened the one limit that works by 10×, so the direction of Sam's decision stands. What does not stand is calling ~$1 enforced.

**One measurable input, available today.** `liteLLMCallId` is captured per turn, so **LiteLLM's own spend log is a second source needing no code change** — real cost is a query away, not a feature. And the capture path is already written (`:860-867` reads `llmResponse.usage`, `:927` saves it), so this is a findable bug rather than work to schedule. **Which of three causes empties `usage` is one run's logs away, and changes the fix cost by an order of magnitude.**

**The trap this ADR must not walk into.** `nativeRuntimeService:621` counts runs on `{ podId, agentName, instanceId }` — **per installation**. Today that equals per user only because Scout is `perUser: true` with exactly one install per workspace. **The moment a user can hire several personas, N hires means N × 60**, and "per user" quietly becomes "per user per persona."

So a seat-denominated allowance needs a **per-user ceiling in addition to the per-installation cap**. The per-installation cap stays — it is the runaway-loop guard for a single conversation. The per-user ceiling is what makes "1 hosted colleague included" a promise we can price.

**It multiplies in TWO directions, not one** (fable-lead). N hires = N × cap, *and* one hire placed in M rooms = M `AgentInstallation` rows = M × cap. So under D2's "pick room(s)" step, **a single colleague working in three rooms is silently three colleagues' worth of spend.**

> **Invariant.** A per-user daily ceiling — keyed on `installedBy`, summed across all hosted installs — is a **prerequisite for offering the second hosted seat or multi-room placement of a hosted hire.** Not a fast-follow.

In v1 (Scout only, one install) per-install equals per-user by construction, so nothing needs building now; the invariant exists so the where-step cannot outrun the ledger. **Ledger shape when built: ceiling per user, fairness per hire beneath it, per-pod never** — a colleague in three rooms is one colleague.

**It cannot be built where the cap lives** (sprint-review). `AgentRun` has **no user field at all** — `podId`, `agentName`, `instanceId`, and the index matches. A per-user ceiling therefore needs either a denormalized `userId` (forward-only; no backfill, since the field never existed) or a join on the hot path. Neither is free, which is why this is a prerequisite rather than a fast-follow.

**And the cap fails OPEN by design** (`:614`) — a count failure proceeds rather than declines. That is right for a runaway-loop guard and wrong for a spend ceiling. **Decide it deliberately rather than inherit it**, because the two have opposite safe directions.

**Seat machinery already exists** — `User.entitlements.cloudAgents`, gated at `install.ts:361` — so v1 needs no ledger. But "a promise we can price" needs a unit cost, and that needs the telemetry above. **We avoid M4's ledger and inherit M4's open question.**

**The window is fixed, not rolling** — `dayStart.setUTCHours(0,0,0,0)` with `startedAt >= dayStart`. So 60 runs at 23:59 UTC and 60 more at 00:01 is reachable: the real burst bound is **2 × `dailyRunCap`** across the boundary.

**Presentation does not change; enforcement does.** Present the seat, never the arithmetic. A seat that silently multiplies is an enforcement bug, and bugs do not get fixed in copy.

**Correction — telemetry EXISTS, and the $1 is now measured rather than guessed.** An earlier draft of this ADR said "the fields exist and nothing populates them." That was wrong, and the error was mine: the accounting code runs on main (`nativeRuntimeService:865-867` per turn, `:926/:936` accumulating into `run.totalTokens`), and my query checked a root-level `promptTokens` that the code never writes. Measured properly, 2026-08-14:

| metric | value |
|---|---|
| runs with token data | **2,225** of 6,624 |
| median tokens/run | **8,146** |
| mean tokens/run | 17,418 |
| p90 / max | 51,748 / 54,398 |

So the true daily ceiling is `60 × ~17k ≈ 1.05M tokens/user/day`, which on a flash-tier model sits **comfortably under the $1 figure** — the allowance has roughly 3–10× headroom over worst case, not zero.

**RESOLVED — the zeros are not unmeasured usage, and there is no telemetry bug.** fable-lead and sprint-review both suspected `Number(usage.total_tokens || 0)` was converting *unmeasured* into *zero*. Measured 2026-08-14, splitting the zero-token runs by status:

| status / errorKind | count |
|---|---|
| `failed` / `llm_error` | **4,395** |
| `running` / none (in flight) | 3 |
| `failed` / `guardrail_blocked` | 1 |

**A failed LLM call has no usage to record, so zero is correct for all of them.** The accounting path works; earliest run carrying tokens is 2026-04-12. The $1 estimate rests on 2,225 *successful* runs and stands.

**But the number that produced this answer is the actual finding, and it is worse than the question.** Over the last 30 days: **891 native runs, 19 with tokens — a ~98% failure rate.** The newest zero-token runs are `pod-summarizer`, failing `llm_error` with 0 turns **every six hours on a cron** (04:00, 10:00, 16:00, 22:00 UTC), for at least a month, entirely silently. Scout on `deepseek-v4-flash` is healthy by contrast — 10 of 14 runs in the last 24h carried tokens, and the 4 that did not are that same summarizer cron.

Two consequences:

1. **This independently validates retiring `pod-summarizer`** (decision 5). It is not merely redundant — it has been failing on schedule for a month and nobody noticed, which is the strongest possible argument that a scheduled resident nobody asked for is a liability rather than a feature.
2. **Silent scheduled failure is the same family as the at-cap `status:'succeeded'` and the swallowed broadcast claim.** Three unrelated subsystems, one shape: *the work does not happen and every component reports success.* That deserves a named kernel invariant, not three separate fixes.

**At-cap persists nothing, and reports the opposite of the truth** (pod-architect, sprint-review). The decline path at `:633` returns:

```js
return { runId: '', status: 'succeeded', totalTurns: 0, totalTokens: 0 };
```

**`status: 'succeeded'`.** No `AgentRun` row is written, and the boundary appears nowhere but a `console.warn`. So a capped turn is indistinguishable from a run that completed normally with zero turns, and D7's quota axis has **no signal to read** — it needs a **producer at `:633`** before it needs a chip.

**And look at what that shape is:** a user mentions Scout, Scout is at cap, the run "succeeds," nothing is posted, the room says nothing. **That is the 03:30 user's experience reproduced by the cap instead of by a dead wrapper** — the exact silent-success failure this entire ADR line exists to delete, re-entering through the surface meant to prevent it.

**The cap must not be reachable inside a single engaged first-day conversation** (fable-lead). "Surface only on hit" is designed for a *backstop*, and holds only while the cap stays one. If real cost rises, the levers in order are **model choice, then per-run `maxTokens`/`maxTurns`** — degrade per-turn spend, never continuity. A colleague that thinks in smaller steps is still a colleague; one that stops mid-conversation on day one is a meter, and softer copy in that world is just a meter with manners. So do not redesign the copy for that world — build the tripwire: **alert when any user caps out within 24h of signup, or first-day hit-rate exceeds ~1%, and treat a first-day cap-hit as an incident (the allowance is wrong), not a UX state.**

**The abuse surface is account creation, not usage.** At ~0.3% utilization instance-wide (about 4 native turns a day against 1,260 available across 21 users), honest users are nowhere near the cap. The exposure is linear in *accounts*, at ~$1/day each, and registration is open. Rate-limiting or entitling seat grants — not tightening the cap — is the control that matters.

## D7. At-cap is a new AXIS, not a liveness state (ux-lead)

Quota does **not** go inside the `AgentReachState` enum. `(liveness, config, quota)` **compose**; folding quota into liveness recreates the precedence trap decision 6 already paid for. This is what makes fable-lead's *"liveness means will answer, not can execute"* rule true rather than merely asserted — a capped-out native agent is `reachable` **and** at-quota, and the surface reports both.

**Tone is calm, not attention.** A working cap is the system succeeding; attention-tone here trains cry-wolf. Copy is flat because our own counter is structurally certain — no hedging needed — and it is the one bad state with a **knowable end**, so it carries the reset time:

> "At today's limit — answers again at HH:MM"

**Never "back tomorrow."** For UTC+8 the reset lands at 08:00 local on the *same calendar day*, so "tomorrow" is false for everyone east of UTC — and falsely **pessimistic**, which is the rarer and more damaging direction.

**The boundary is UTC midnight** — `nativeRuntimeService:621` does `dayStart.setUTCHours(0,0,0,0)`, verified rather than assumed.

**And the boundary is arguably wrong, not just awkward to phrase** (pod-architect). UTC midnight is **08:00 in UTC+8**, so a Chinese user's cap resets *at the start of their workday*. Exhaust it by 10am and they are dark for **22 hours** — the worst possible phase for exactly the audience this copy exists to serve, and two of the users this ADR is built on wrote Chinese. **Argue the boundary before the copy commits to a time.** A rolling 24h window, or a reset keyed to the user's own timezone, may be the actual fix; "which words describe UTC midnight" is the wrong question to answer first.

Never currency, per D5. The mention-time inline cue inherits it: *"will answer"* becomes *"will answer at HH:MM."* **Disabled-by-owner is the quota-axis sibling** — same calm tone, and the fix names the owner.

## D8. Ambient state and the event nudge are layers, not rivals (ux-lead)

The awaiting-seat member card is **ambient** (persistence); the stalled-connect nudge is the single **event**. Ambient-plus-one-post is exactly the #891 pairing, and the stalled-connect spec's episode record governs **posts only, never card state**. Three pins keep them from drifting:

1. Both consume the **one class-scoped derivation**, so card and nudge cannot structurally disagree.
2. The nudge's *"I'll post here the moment it connects"* stays **owed** even after the card flips green — the promise was a post, and an ambient state change does not discharge it.
3. **Installer = owner for hires**, so the card's owner-only `fixCommand` and the nudge's installer-addressed copy land on the same person by construction. If a future hire flow ever splits those, both surfaces must key on the same field rather than two.

**Pin 3 verified, with a hole** (pod-architect). `installedBy` is `required: true`, populated on all 322 active installs, and `agentStateService:100` keys `isOwner` on exactly that field — one field, and because both surfaces read it they fail *together* rather than contradicting each other, which is the pin working.

**But 53 of 322 have a BOT as `installedBy`** (mostly `commonly-bot`). For those, `isOwner` is false for every human: the card renders **no `fixCommand`** and the nudge has **no addressee**. For the funnel population it is small — **1 of 20** self-serve seats.

**The pin is true of the field and false of the test, and the divergence already shipped** (sprint-review):

```js
// card    — agentStateService.ts:94   raw string compare, no load, no isBot check
String(installation.installedBy || '') === String(callerId || '')

// approvals — approvalActionService.ts:164,172   what #940 shipped
resolveHumanDecider(candidates)          // installer → pod-creator fallback
  if (user && user.isBot !== true) …     // loads the User, rejects bots
```

Same field, **different predicate**. Where `installedBy` is a bot, approvals fall back and find a human while the card's `isOwner` is false for *everyone* — it shows a broken agent and offers the fix to nobody. Where it dangles (the seeder's hardcoded admin id on a self-hosted instance), approvals fall back and the card simply never matches.

**So the pin strengthens from "both key on the same field" to "both use the same resolution."** Otherwise a future hire flow does not have to split the field to split the surfaces — it only has to install via a path that writes a non-human, and three such writers already exist.

**One honest constraint on that fix:** `deriveAgentState` is a pure sync function called inside a `.map()` (`pods.ts:446`), while `resolveHumanDecider` is async because it loads a User. Sharing the resolution needs the resolved owner **precomputed and passed in**, or the card's derivation made async. Worth knowing before anyone writes it down as a small pin.

## Do now, regardless of ratification (fable-lead)

1. **Filter internal and ephemeral rows out of `/api/registry/agents`.** It ships 21 smoke and internal rows today and the logged-out landing footer links it. The marketplace path already has the filter to copy. This is a live leak, not a redesign step.
2. **Settle the v1 cast: Scout + Code Reviewer + at most one more.** Each must pass three tests — tools that exist in today's MCP surface; a deliverable demonstrable in a two-turn sample; and a reason to be a **resident** rather than a feature. `pod-summarizer` fails the third test, which is precisely why reworking it into a triggered TLDR is the right call rather than porting it.

## What this does not decide

Whether personas are user-authorable or curated-only; marketplace publishing of personas; per-persona memory scoping. All deferred until the shape above is settled.
