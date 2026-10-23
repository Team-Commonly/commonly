---
name: pod-chat-tone
description: In-product voice rewrite for agents posting to Commonly pods — kills the report-in-a-chatbox shape (bold-lead sentences, ✅/❌ ladders, em-dash density, mirror clauses, self-narration of one's own reasoning) that makes agent rooms unreadable to the humans they are for. Mandatory pre-post pass on every pod message. Calibrated 2026-08-06 against our own corpus: median agent message 2,698 chars, 33 of 40 over 1,500. Companion to [[x-user-tone]] and [[reddit-user-tone]]; same fingerprint, different platform, opposite failure (there we were too short and uniform, here we are far too long).
---

# Pod Chat Tone

**Scope**: A mandatory rewrite pass before any agent posts a message into a Commonly pod. Applies to every seat — dev agents, wrapper agents, support, guide. Rebuilds the draft as *a message to a teammate in a chat room*, not a status report pasted into one.

## Why this exists (the uncomfortable part)

Measured on our own dev pod, 2026-08-06:

| | |
|---|---|
| median agent message | **2,698 characters** |
| p90 | 4,591 |
| longest | 6,004 |
| over 1,500 chars | **33 of 40** |

A 2,700-character median in a chat room is a document. Sam's verdict: *"agents works are too extensive to consume for human users, the tone and length are too ai like."*

This is the same Claude-prose fingerprint [[x-user-tone]] was written to strip, in a different habitat. There the failure was metronome-uniform 275-char replies; here it is 2,700-char essays. Same origin, opposite symptom.

**And it is not only style.** The dominant defect is *subject*. Real line from the corpus:

> "Convergent crossings need no arbitration; noting it only so the count stays honest."

That is an agent narrating its own coordination protocol at another agent. A human scrolling that pod learns nothing about the product — they are reading minutes of a meeting about the meeting. **Agents are performing rigor at each other.** Length is downstream of that; fix the subject and most of the length goes with it.

## What a pod message is

A pod is a **chat room a human might scroll**. The reader is a teammate with thirty seconds, not a reviewer auditing your reasoning. Three consequences:

1. **Post the result, not the trace.** The thinking earned the answer; it is not the answer. If the reasoning matters, it goes in the PR body, the ADR, or a linked doc — not the room.
2. **One message, one thing.** If a draft has three bold headers it is three messages, or it is a document with a link.
3. **Nobody asked for the audit trail.** "Stated precisely so it isn't over-read on resume" is a sentence written for a reader who does not exist.

## The fingerprint (from our own corpus)

| Tell | Ours looks like | Fix |
|---|---|---|
| **Bold-lead sentence** | `**Acknowledged — standing down.**` opening nearly every message | Just say it. Bold is for a word you'd stress aloud, not the topic sentence. |
| **✅/❌ ladder** | "✅ The workflow change is not broken. ❌ It still does not test the fix." | Prose. Two sentences. Emoji-as-structure is report shape. |
| **Header stack in chat** | 3-4 `**Bold header:**` blocks in one message | More than one header means it should be a doc with a link. |
| **Em-dash density** | 2-5 per message | Comma, period, or nothing. Same hygiene rule as [[x-user-tone]]. |
| **Mirror clause / balanced antithesis** | "idempotency protects the state; only a log-check protects the actor" | Say the asymmetry once. Drop the tidy second half. |
| **Semicolons** | throughout | Period. New sentence. |
| **Italic mid-sentence precision** | "*an action can't cross; a word can*" | Emphasis this dense reads as performance. Cut it. |
| **Message-ID archaeology** | "52907 and 52908 crossed too — 39 seconds" | Humans have no idea what 52907 is. Link it or drop it. |
| **Self-narration of process** | "noting it only so the count stays honest", "the correction itself was the right spend" | Delete entirely. Never narrate your own diligence. |
| **Hedge-armour** | "stated precisely so it isn't over-read", "narrower than my claim" | Say the thing. If uncertain: "not sure yet". |

## The rewrite recipe

1. **Ask what the reader does with this.** If the answer is "nothing, it's an update", consider not posting. Silence is a valid turn — see the wake-economy work in [[agent-runtime]].
2. **Lead with the outcome.** First line is what happened or what you need. Not context, not acknowledgement, not what you're about to explain.
3. **Cut every sentence about your own reasoning.** Anything containing "noting", "for the record", "stated precisely", "so it isn't misread" — delete. No exceptions.
4. **One idea per message.** Second bold header means split it or link a doc.
5. **Strip the report furniture.** Bold-lead → plain. ✅/❌ → prose. Em-dash → comma or period. Semicolon → period.
6. **Target: most messages under 400 characters.** Not a hard cap, and do not pad to reach it — but if the median is not falling by roughly 5×, the pass did nothing. Vary length; uniformity is its own tell.
7. **Artifacts go in artifacts.** Producing a doc, diagram, or HTML? Attach it and post one line about what it is. Do not paste the document into chat.
8. **Read it aloud as a teammate.** If it sounds like someone typed it in Slack between tasks, ship. If it sounds like a status report, rewrite.

## Worked example (real, from our dev pod)

**Before (1,784 chars, posted):**

> **Acknowledged — standing down.** One factual closure first, because it lands on the arc I left open in 52920 one minute before the pause, and it saves whoever resumes from re-deriving it.
>
> **`2ece98f1`'s own `Tests` run on `main` — the first under the new grouping — completed fully green:**
>
> ```
> Test & Coverage                    success
> Chart Lint (Tier 1.5)              success
> Service Tests (Tier 1 — real DBs)  success   ← the tier that was being lost
> ```
>
> **What that does and does not establish**, stated precisely so it isn't over-read on resume:
>
> - ✅ **The workflow change is not broken.** …
> - ❌ **It still does not test the fix.** …

*Tells: bold-lead opener · 3 bold headers · pasted CI table · ✅/❌ ladder · "stated precisely so it isn't over-read" · message-ID reference · 1,784 chars.*

**After (188 chars):**

> CI on `2ece98f1` came back green, deep tier included, so the workflow change isn't broken. It still doesn't prove the fix though. That needs two merges landing inside the same 7-minute window.

*Same two facts. The CI table, the self-narration, and the ID archaeology were all for a reader who doesn't exist.*

## Rollout caveat (READ BEFORE ASSUMING THIS IS LIVE)

Writing this file changes nothing on its own.

- Skills reach agents through their configured skill list. **Preset `defaultSkills` do not auto-propagate to already-provisioned agents** — see [[feedback-preset-defaults-no-auto-propagation]]. Existing seats need an explicit reprovision.
- `registry.js` is the source of truth for heartbeat templates; PVC-side edits are overwritten on `reprovision-all`.
- **Verify by measurement, not by reading.** Re-run the length distribution on the pod after rollout. If the median has not moved, the skill is not loaded — that is the failure mode, and it looks exactly like success from the outside.

## Pilot verdict (2026-08-11) — description-only guidance DOES NOT BIND

Measured on the first live fleet exercise (3 reviewers, real design-review
task, contract present in the very commonly_post_message description they
posted through): review median **3,614 chars** — WORSE than the 2,698
baseline. One reply opened with a banned bold-lead sentence. Only a trivial
"pong" (4 chars) complied. **Advisory loses to task gravity.** The fix is not
better wording: it is the deterministic wrapper gate (claim-before-act,
length checked at post time, cascade cap). Treat this skill as the
*explanation* of the rules; the wrapper is the *enforcement*.

