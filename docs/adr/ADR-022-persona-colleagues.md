# ADR-022: Persona colleagues — separating who an agent is from where it runs

- **Status:** Draft (design lead input pending; Sam to ratify)
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

Exact field set and which parts a user picks vs. we curate: **design lead's call, deliberately open below.**

### 2. Persona and runtime are chosen separately, in that order

Pick who → pick where. "Where" offers hosted (native today, pi later per ADR-021) or your own machine (BYO). Changing where must never change who — that is ADR-001's identity-continuity rule, and it is the property that makes the split worth having.

### 3. The hosted half ships on the runtime we already have

The native runtime already executes four distinct personas off one engine with different prompts. **It is already persona-parameterized.** A persona picker over the native runtime delivers a working colleague in one click today, with no dependency on ADR-021's milestone track.

This is the single highest-leverage fact in this document: the hosted experience is not a future capability, it is a shipped one with a fixed cast.

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

## Open — design lead (fable-lead) owns these

1. What a persona *is* as a user-facing object, such that "Code Reviewer" reads as a colleague and not a config blob.
2. The pick-then-place flow, and where it lives: replacing `/v2/agents/browse`, folded into Your Team, or reached from the pod invite.
3. How personas differ in-room. Scout's voice works; what generalises, and what must vary per role so three colleagues do not read as one model wearing hats.
4. How rationing appears without feeling like a paywall bolted onto an empty room.

## Open — Sam

5. **The free hosted allowance.** Some non-zero amount of hosted persona use for unentitled users, or personas gated behind entitlement and free users still landing on BYO. This is the decision the rest depends on, and it is a money decision.

## Consequences

- A new user can have a working colleague without installing anything. That is the activation path we have never had.
- The v1 catalog, its 5,039-line component, and the leak of internal agents all go away as a side effect rather than as separate cleanup.
- BYO stops being the default first experience and becomes the graduation step it should always have been — which is also where today's honesty work (#943, #945, #947) pays off, since by then the user has a working agent and is choosing to add another.
- We take on curation cost: personas are content, and bad ones are worse than none.
- If the allowance is zero, this ADR delivers a better-shaped catalog and **not** a better activation rate. Worth stating plainly so the outcome is not misread later.

## What this does not decide

Whether personas are user-authorable or curated-only; marketplace publishing of personas; per-persona memory scoping. All deferred until the shape above is settled.
