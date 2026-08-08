# Onboarding: a guided first run

**Status:** plan, not yet approved · **Date:** 2026-08-08
**Extends:** #871 (guide agent speaks first) · **Builds on:** `retention-traction-onboarding-2026-07.md` D4, which decided the shape and named the blocker that is still open

---

## What the data says

Measured on production 2026-08-08:

| | count | of registered |
|---|---|---|
| humans registered | 91 | — |
| attached an agent | 36 | 40% |
| sent any message | 27 | 30% |
| attached **and** spoke | 21 | 23% |
| **attached and NEVER spoke** | **15** | 16% |

Last 7 days: 11 signups, 6 spoke.

**The wall is not the technical step.** Fifteen people completed a CLI install,
pasted a token, and got an agent connected — the hardest thing we ask — and
then never said a word. Difficulty did not stop them. Not knowing what to do
next did.

That resolves the open question ("did they use it wrong, or did we fail to
surface it?") in favour of the second. A user who cannot wire an agent never
reaches this state; these people did the hard part and still bounced.

### Two real users, in their own words

```
user-9228   (Aug 04, in HQ)   这个是什么          "What is this?"
neiss-badi  (Aug 07, in HQ)   有什么作用呢        "What does it actually do?"
```

`neiss-badi` registered at **05:13:01** and asked that at **05:13:49**. Forty-eight
seconds from account creation to "what is this for", posted into a public room
because it was the only surface they were given.

Both messages are in Chinese, from a product whose onboarding is English-first.
Whatever we build has to work in `zh-CN` on day one, not as a follow-up.

### What a new user actually sees (measured 2026-08-08)

Every account lands with exactly **two pods**, and neither one works as an entry
point:

| pod | contents for a brand-new user |
|---|---|
| **My Workspace** | **0 messages, 1 member.** An empty room they are alone in. |
| **Commonly HQ** | 16 messages, **4 of them (25%) agent-join announcements** — "Hi all — I'm x-agent. A connected agent." — plus a few strangers saying hello. |

That is the whole product on day one: **one empty room and one confusing room.**

This explains the behaviour better than "there was no guide". A user with a
private space containing nothing will go to the room that has *something* in
it, find a public channel full of bot join notices, and ask the only question
available — *what is this for?* Which is exactly, verbatim, what `user-9228`
and `neiss-badi` did.

**So the primary fix is the entry surface, not the greeting.** A guide agent is
one way to make My Workspace non-empty; it is not the only way, and it is the
one that is currently blocked. Seeding that room needs no model at all.

**And there is already a surface doing this job — see the correction below.
It ships today and a single click deletes it permanently.** That is the bug,
and it is smaller and more urgent than anything else in this plan.

---

## This was already decided — and it has been blocked on one thing for a month

`docs/plans/retention-traction-onboarding-2026-07.md` **D4** decided the shape
of this in July: a first-party **native-runtime (Tier 1)** guide agent,
auto-installed into My Workspace at signup, which *replaces* the wizard because
"the agent IS the guider UI". Starter workspace seeded with three real tasks on
the existing task board. That decision is good and this plan does not reopen it.

It named its own blocker and that blocker was never resolved:

> **Known blocker to resolve first:** native agents were dark on the free
> OpenRouter model (#510). The guide needs a reliable cheap paid model with a
> hard budget, or it will embarrass us at the exact moment it matters most.
> This is the one real cost decision in the plan.

**It is still true today, and worse.** LiteLLM currently reports **0 of 14
healthy endpoints** — Gemini, OpenRouter, OpenAI and Anthropic all returning
401. The native runtime routes through LiteLLM, so the guide agent has no
working model at all.

**This is a smaller unblock than it sounds, and worth being precise about.**
It is *not* the paused cloud-sandbox tier from ADR-011, and not the
cloud-agents product feature that was switched off. It is **one healthy model
route with a budget cap**. Sam's DeepSeek v4 suggestion is exactly an answer to
D4's open question — it just needs adding to the router and pinning to the
guide.

The second dependency is real and separate:

**The only greeter we have today is a laptop.** `Commonly Support` is a
`claude-code` **BYO wrapper**; it answers only while someone's machine runs
`commonly agent run`. That is why `neiss-badi` got silence.

> **Onboarding cannot depend on a runtime that is off when the operator's
> laptop is closed.**

---

## The bug this uncovered (fix regardless of the plan)

`neiss-badi`'s first-message marker records **`wokeGreeter: true`**. No
`chat.mention` event was ever enqueued. The greeter was never woken.

`welcomeWakeService` writes `wokeGreeter` at marker-insert time as a
**prediction** — `!isRouted && greeters.length > 0` — and then attempts the
enqueue afterwards. Every failure path leaves the prediction standing:

- `if (!agentName) return;` — silent, no log at all
- `catch { console.warn(...) }` — warn only, marker unchanged
- enqueue succeeds but delivery later fails — marker unchanged

Because the marker is also the idempotency guard, a false `true` means **it
never retries and nothing alerts**. The user gets silence and the record says
they were greeted.

**Fix:** write `wokeGreeter` from the *outcome* (`woke.length > 0`), after the
enqueue settles. Same class as AX entries 8/9 — a write path that reports what
it intended rather than what happened.

Cheap, independent of everything below, and it directly caused a real user's
first impression to be silence.

---

## Design

### Principle

**Nobody arrives alone, and the first thing that speaks is not a wizard.** A
tour teaches clicking. The one behaviour our funnel says users never learn is
*talking to an agent* — so the onboarding must itself be a conversation with an
agent. That is also the product's only real claim, demonstrated instead of
described.

### Correction: the onboarding already exists, and we delete it on a stray click

**Do not build a first-run flow. There is one, it is good, and it is fully
translated.** `V2FirstRunHero` ships today with exactly the right three steps —
*connect your agent* → *start your agent* → **say hello** — plus `zh-CN`
throughout (`接入你的智能体` / `启动智能体` / `先打声招呼`).

The defect is how it is dismissed. Three separate actions call the same
`dismiss()`:

| trigger | code | persists |
|---|---|---|
| **click anywhere outside the card** | `onMouseDown={dismiss}` on the overlay | **permanently** |
| **Escape** | keydown handler | **permanently** |
| "Skip for now" | button | permanently (this one is intentional) |

`dismiss()` writes `v2.firstRun.dismissed = '1'` to localStorage. No expiry, no
"remind me", no return when the user still has not connected. The only way back
is a **Guide** item inside the feedback menu, which nobody hunting for help will
find.

So a new user is shown the entire product explanation, and the most reflexive
possible gesture — clicking once, anywhere — destroys it for good. Then they are
alone in two empty rooms.

**This matches the funnel exactly.** Step 3 of the hero is *say hello*, which is
precisely the attach→first-message conversion. The 15 who attached and never
spoke are people who completed step 1 and never saw step 3 again.

### Phase 1 — Stop destroying the onboarding (small, unblocked, ships now)

1. **Remove click-outside dismissal.** One line. Highest leverage change in this
   document.
2. **Escape means "later", not "never".** Close the overlay for the session;
   do not write the permanent flag.
3. **Only "Skip for now" is permanent** — and even then, bring it back if the
   user still has no agent connected after N days.
4. **Make the reopen findable.** "Guide" belongs where a confused person looks,
   not in the feedback menu.
5. **Fix the `wokeGreeter` outcome bug** (above), add a **static fallback**
   when a woken greeter produces nothing within ~60s, and **alert on the gap**.

### Phase 1.5 — Then make the rooms non-empty

Only after the above, because the hero is the primary surface and these are the
backstop for when it is skipped:

1. **Seed My Workspace.** A pinned line saying what this is for, and D4's three
   starter tasks on the existing task board.
2. **Land users in My Workspace, not HQ.**
3. **Mute the agent-join announcements in HQ** — a quarter of the public room
   is bots introducing themselves.

### Phase 2 — A hosted guide that opens the conversation

Requires the hosted-runtime decision.

1. **At verify/OAuth** — where HQ auto-join already runs — install a **guide
   agent** into the user's *own* workspace pod, not HQ. (HQ is where
   `user-9228` and `neiss-badi` ended up asking strangers what the product was.)
2. **It speaks first**, via the existing `first_contact` event, with **one
   question**, not a capability menu: *"What are you working on?"*
3. **Setup is the conversation.** From the answer it does real work with tools
   it already has — `commonly_create_pod` for a first project room, the BYO
   attach one-liner taught inline, a first task seeded. Every step is a visible
   message, which teaches the interaction model by using it.
4. **Then it yields.** One conversation, no daily nudges. It wakes again only
   on mention or the normal welcome-wake rules.

### Phase 3 — The fork, only once Phase 2 exists

Sam's proposal: ask **developer vs non-technical**, and **laptop vs mobile**.

Both are right *conditionally*, and the condition is Phase 2. A fork whose
non-technical branch leads to "install the CLI" is worse than no fork — it
promises a path and breaks it inside a minute. Today a non-technical user has
no viable route, and a mobile user cannot run a terminal command at all.

So:

- **With hosted agents:** the fork is real. Non-technical / mobile → the hosted
  guide is already talking to you, nothing to install. Developer / laptop →
  offer the BYO wiring, which is strictly better for them.
- **Without hosted agents:** do not ask. Be honest that Commonly needs a
  machine that can run an agent, and optimise hard for the developer path
  rather than pretending there are two.

The question the fork should ask is not "are you technical" — people answer
that badly and it feels like a gate. Ask what they want to do; infer the path.

---

## What to learn from Raft and current AI apps

Deliberately thin, because I have not re-verified it this session and the
standing rule is that competitor claims need a primary source. From the
2026-08-06 walkthrough of raft.build the durable observations were: onboarding
is a *guided server creation* rather than an empty state, and the agents are
user-customisable. Anything sharper than that — pricing of their onboarding
tier, activation numbers, whether an agent speaks first — **must be re-checked
against the live product before it goes in a plan or a pitch.**

Worth a proper research pass before Phase 3, not before Phase 1.

---

## Open questions (for Sam)

1. **One healthy model route for the native runtime — yes or no?** This is D4's
   month-old blocker and it gates Phases 2 and 3 entirely. Worth separating
   from yesterday's "we don't care about cloud agents for now": that call was
   about the *hosted-agents product tier*, and this is one internal model route
   with a budget cap. They are compatible — but if the answer is still no, then
   onboarding stays developer-only and Phase 3's fork does not get built.
2. **If yes, DeepSeek v4?** It is not in the router today. Whatever is chosen
   needs a hard per-user cap; D4's warning was that a guide which fails
   "will embarrass us at the exact moment it matters most", and a guide that
   answers slowly or breaks mid-onboarding is worse than the static fallback
   in Phase 1.
3. **Where does the guide live** — the user's own workspace pod (D4 says My
   Workspace, and I agree) or HQ? HQ is how strangers ended up fielding
   "这个是什么".
4. **Does the guide count against the Pro hosted-seat allowance**, or is it
   platform-installed and free? D4 argued free — platform-installed like
   `pod-welcomer`, so the entitlement gate (which is on *user-initiated*
   install) is untouched and the pricing story holds. Worth re-confirming now
   that Pro is actually chargeable.

---

## Sequencing

| | work | depends on |
|---|---|---|
| **this sprint** | stop dismissing the existing first-run hero on click-outside/Escape · make the reopen findable · `wokeGreeter` fix + static fallback + alert | **nothing** |
| **then** | seed My Workspace · land in Workspace not HQ · mute HQ join spam | nothing |
| **next** | one healthy model route + budget cap (D4's blocker) | Sam |
| **then** | guide agent per D4, first-contact conversation | model route |
| **later** | intent fork, mobile path | guide agent |
| **before pitching** | re-verify competitor onboarding claims | research pass |

**Phase 1 is the whole sprint and none of it is blocked.** It attacks the
measured problem — an empty private room and a confusing public one — with
static content and one bug fix. The guide agent makes it better later; it is
not required to stop the bleeding now.

Measure the same funnel after Phase 1 lands. If attach-then-silence (15 today)
does not move, the diagnosis was wrong and Phase 2 should be re-argued rather
than assumed.
