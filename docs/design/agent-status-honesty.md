# Agent status honesty — design brief

**Status:** brief for agent-staff design review, not a spec
**Date:** 2026-08-11
**Owner:** Sam (ratifies) · design review: UX Lead + fleet
**Grounding:** #887 / #888, the 2026-08-09→11 silent-mention incident

---

## The problem, with names attached

Between Aug 7 and Aug 11, four users connected an agent through the web flow,
spoke to it, and got silence: `spiderpc`, `user-8863` (twice), `ngoc-tran`.
A fifth, `user-575a`, connected one and never spoke at all. None of them did
anything wrong. The product told them they had a working agent — Your Team
listed it as calmly as the working ones — and nothing anywhere said otherwise
until #888's one-line patch ("Never connected").

That patch is a *label*. This brief is for the actual design: **agent health
as a first-class, honest, designed surface** — because the current page was
built to display a roster, and the job has turned out to be displaying a
*fleet*, where the difference between alive and dead is the whole point.

## What the kernel can honestly derive (measured, not aspirational)

Every state below is computable from signals that exist today. No new
telemetry is required for v1.

| state | signal | seen in production |
|---|---|---|
| **Listening** | `runtimeTokens.lastUsedAt` within threshold (wrapper polls CAP continuously) | the working fleet |
| **Gone dark** | `lastUsedAt` exists but stale — it worked, then stopped (laptop closed) | every wrapper, daily |
| **Never connected** | all `runtimeTokens.lastUsedAt` null — token issued, never used once | 5 new installs this week alone |
| **Misconfigured** | `runtimeType: webhook` with no URL — cannot ever be delivered to | 13 installs |
| **Degraded** | acks events but never acts (the hq-support state: MCP tools absent, replies only by the wrapper's implicit post) | live in HQ today |

Open problem for review: **Degraded has no clean kernel signal yet.** The
ack traffic and the implicit post both look like activity. Options include
tool-call telemetry or a driver-side self-report; both have costs. This is
the hardest question in the brief and the reason it needs more heads.

Thresholds are the second open problem: "stale" must be derived from the
wrapper's actual poll cadence (measure it; do not guess), with hysteresis so
an agent doesn't flap between states on one slow poll.

## Design principles (argue with these in review)

1. **Alarm where the user owns the fix.** Your agents' health is your
   problem; a pod-mate's dead agent is not. The alarming surface keys on
   *ownership*, not on room membership. Nobody gets a wall of red about
   other people's agents.

2. **Explain at the moment of failed expectation.** The highest-value
   intervention is not a dashboard — it is the moment a human @mentions an
   agent that cannot answer. That is where `ngoc-tran` was lost. An inline
   system line at send time ("`ngoc-tran-agent` isn't connected — it can't
   see this yet. Fix: …") converts the #887 silence into an explanation
   *in the room, at that second*. This is the single most important surface
   in the brief.

3. **Health is a dimension, not a decoration.** On Your Team, state should
   organize the page (working agents first, broken ones grouped with their
   fix), not be a timestamp footnote on an otherwise-identical card.

4. **Every bad state names its fix.** "Gone dark" → the `commonly agent run`
   command with the agent's name. "Misconfigured" → what to change. A state
   without an attached action is an accusation, not a design.

5. **One accent stays one accent.** The design system's cobalt is not a
   status color. Health needs a small semantic set (ok / attention /
   broken) added to the token system deliberately — tokens.css and v2.css
   move together — and used only here. Borders-not-shadows, sentence case,
   no emoji-as-structure all still apply.

6. **Honest, not alarmist.** "Gone dark" is *normal* for laptop-hosted
   agents overnight. The design must distinguish "expectedly asleep" from
   "was never alive" without making the first feel like an outage. This is
   a copy problem as much as a visual one, and it ships in zh-CN from day
   one (every confused user this week wrote Chinese).

## Surfaces, in priority order

1. **Mention-time inline explanation** (principle 2) — the one that would
   have saved every user named above.
2. **Your Team restructure** — state-grouped, fix-attached, live-updating.
3. **Pod inspector member list** — a quiet dot per agent; detail on the
   agent profile, not inline.
4. **Nav-rail notifier** — a single badge when *your* agent enters a bad
   state; deep-links to the fix. No global health feed. Considered and
   deliberately deferred: email/push (retention plan territory, not this).

## Process

This goes to the fleet for design review before any implementation:
UX Lead on the interaction model and the alarm/calm balance, Pod Architect
on the state derivations and the Degraded signal problem, Sprint Review as
adversary on principle 1 (is ownership-keyed alarming actually right?).
Review happens in the Sharpen pod under the new tone contract — short
messages, results not reasoning, claims before acting (ADR-018 conventions
apply the moment it is ratified).

Sam ratifies the reviewed spec; implementation is sliced after that, with
surface 1 first.
