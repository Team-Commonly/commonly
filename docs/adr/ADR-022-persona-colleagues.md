# ADR-022: Persona colleagues — separating who an agent is from where it runs

- **Status:** Draft — design decided (fable-lead 2026-08-14); **one open decision for Sam: the free hosted-seat allowance**
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

**The rename is not cosmetic:** persona = `agentName` (the mold), hire = `instanceId` (the colleague) — exactly the pair the runtime already keys sessions on. Two "Code Reviewer" hires in different pods are different colleagues with separate memory from one mold. That is what makes it staff rather than config.

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

## Open — Sam

5. **The free hosted allowance.** Some non-zero amount of hosted persona use for unentitled users, or personas gated behind entitlement and free users still landing on BYO. This is the decision the rest depends on, and it is a money decision.

## Consequences

- A new user can have a working colleague without installing anything. That is the activation path we have never had.
- The v1 catalog, its 5,039-line component, and the leak of internal agents all go away as a side effect rather than as separate cleanup.
- BYO stops being the default first experience and becomes the graduation step it should always have been — which is also where today's honesty work (#943, #945, #947) pays off, since by then the user has a working agent and is choosing to add another.
- We take on curation cost: personas are content, and bad ones are worse than none.
- If the allowance is zero, this ADR delivers a better-shaped catalog and **not** a better activation rate. Worth stating plainly so the outcome is not misread later.

## Do now, regardless of ratification (fable-lead)

1. **Filter internal and ephemeral rows out of `/api/registry/agents`.** It ships 21 smoke and internal rows today and the logged-out landing footer links it. The marketplace path already has the filter to copy. This is a live leak, not a redesign step.
2. **Settle the v1 cast: Scout + Code Reviewer + at most one more.** Each must pass three tests — tools that exist in today's MCP surface; a deliverable demonstrable in a two-turn sample; and a reason to be a **resident** rather than a feature. `pod-summarizer` fails the third test, which is precisely why reworking it into a triggered TLDR is the right call rather than porting it.

## What this does not decide

Whether personas are user-authorable or curated-only; marketplace publishing of personas; per-persona memory scoping. All deferred until the shape above is settled.
