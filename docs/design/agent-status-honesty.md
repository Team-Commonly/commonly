# Agent status honesty — design brief

**Status:** reviewed by the fleet (Sharpen pod, 2026-08-12, msgs 52986–52991) and revised — awaiting Sam's ratification
**Date:** 2026-08-11 · revised 2026-08-12
**Owner:** Sam (ratifies) · review: UX Lead 52986 · Sprint Review 52987/52990 · Pod Architect 52988/52989/52991
**Grounding:** #887 / #888, the 2026-08-09→11 silent-mention incident — and now the review's own find: a four-month, fully-recorded first-party degradation (45%→100% failure Apr→Aug, then 8 days of zero runs) that no surface ever showed anyone (#895)
**Follow-ups already filed from review:** #895 (native heartbeat opt-in projection), #896 (boot-backlog ack-without-spawn), #897 (kernel cascade gap), #898 (pod.join has no producer / Unreachable)

---

## The problem, with names attached

Between Aug 7 and Aug 11, four users connected an agent through the web flow,
spoke to it, and got silence: `spiderpc`, `user-8863` (twice), `ngoc-tran`.
A fifth, `user-575a`, connected one and never spoke at all. None of them did
anything wrong. The product told them they had a working agent — Your Team
listed it as calmly as the working ones — and nothing anywhere said otherwise
until #888's one-line patch ("Never connected").

The review added a second class of casualty: **the product's own first-party
apps.** `pod-welcomer`, `task-clerk`, and `pod-summarizer` failed at rising
rates for four months against a recorded error (`AgentRun` has every failure),
then stopped running entirely for 8 days — and the only surface that ever
reacted was the cleanup cron marking them `stale`, silently, the morning of
the review (52989/52991). An honesty surface is for us as much as for users.

This brief is for the actual design: **agent health as a first-class, honest,
designed surface** — the current page was built to display a roster, and the
job has turned out to be displaying a *fleet*, where the difference between
alive and dead is the whole point.

## What the kernel can honestly derive (measured — and re-measured in review)

The original table treated `runtimeTokens.lastUsedAt` as *the* signal. Review
falsified that for most of the fleet (52988/52991). The derivation is **two
ordered questions** (52988): *can this runtime class write the signal at
all?* — then *what does the signal say?*

| runtime class | honest liveness signal | what `lastUsedAt` actually measures there |
|---|---|---|
| **CLI wrapper** (BYO laptop) | `lastUsedAt` — the wrapper polls CAP continuously | reachability; the only class where "stale = gone dark" holds |
| **moltbot / gateway** | needs route diversity (below) | last *task*, not reachability — 23 agents share one value: the gateway's boot timestamp |
| **native** (first-party apps) | **`AgentRun`** — status, trigger, error, turns, toolCalls; a complete execution log | nothing: permanently null; null is *uninformative*, never healthy (52991, replacing 52988's first reading) |
| **webhook** | config completeness statically; delivery outcomes at runtime | nothing: push-only — the backend posts the reply, the agent never authenticates in |

**The states — six, not five.** Listening / Gone dark / Never connected /
Misconfigured / Degraded survive review with the caveats below.
**Unreachable** is new (52990, confirmed 52991): a component declaring a
trigger no producer emits — derivable **statically at install time** from
`triggers[]` against the emitted-event-type set. Zero telemetry, no
thresholds, and the only row that catches a dead-on-arrival install
(`pod-welcomer`: 0 `pod.join` firings across 1,727 recorded runs — #898).

**Derivation caveats, each measured in review (52988):**

- **Union both token arrays.** The Your Team endpoint reads
  `User.agentRuntimeTokens` only; auth also stamps
  `AgentInstallation.runtimeTokens`. Agents on the legacy path read null while
  live.
- **`runtimeType` goes through `normalizeRuntimeIdentity`** — it is unset on
  88% of stored installs; a rule reading the raw field inspects 24 of 200.
- **States need a precedence rule.** Misconfigured (webhook, no URL) and
  Never-connected fire together on the same 14 installs today — and two of
  those 14 have the freshest `lastUsedAt` in the whole fleet. Structural
  states outrank inferred ones.
- **Never-connected needs a test-debris exclusion.** Whole-fleet it returns
  143 of 304 bots, dominated by `byo-e2e-*`/`byo-smoke-*`.
- **Ack telemetry carries zero information.** 7-day ack rate is ~100% for
  every agent in the fleet, including the degraded one. Nothing may build on
  it.
- **Evidence retention is part of the derivation.** The cleanup cron's
  event-recency criterion false-positived all three native apps because
  `AgentEvent` rows are GC'd on thresholds shorter than the apps' cadence —
  evidence deleted, not never created (52991). Any state derived from event
  history must state the retention window it assumes, or read `AgentRun`,
  which is not GC'd.

**Degraded — resolved in review; neither of the brief's two expensive options
is needed:**

- **Outbound-authenticating classes:** record the route in the `$set` that
  `agentRuntimeAuth` already fires per request (it currently records none).
  Degraded = low endpoint diversity — an agent whose lifetime route set is
  `GET /events` + ack + one post is degraded; a healthy MCP agent also hits
  context, messages, reactions, memory (52988).
- **Native:** `AgentRun.toolCalls` is already persisted per run (52991).
- **Driver-side signature:** an ack with no session-ledger write — the
  boot-backlog bug's shape (#896) — is Degraded's first concrete detection
  predicate.

Thresholds remain open: "stale" derives from the class's *measured* cadence
(per-agent where possible — 52986 wants gone-dark escalation keyed to an
agent's own cadence), with hysteresis so one slow poll doesn't flap the state.

## Design principles (revised in review)

1. **Split the key: alarm is ownership-keyed, explanation is
   dependency-keyed.** (52987's amendment, accepted; it resolves the
   P1↔P2 contradiction the original brief didn't notice.)
   *Alarm* — interruptive, badge, "you must act" — goes to the owner only.
   *Explanation* — in-room, passive, "this won't answer and here's why" —
   goes to anyone whose action or expectation just routed to that agent.
   Fix copy renders only for the owner; everyone else gets attribution copy
   ("`x` isn't connected — its owner has been notified"). This is also what
   gives fan-out installs (1 installer, 20 degrading rooms) and `agent-dm`
   rooms (no owner among the two members, by invariant) a surface at all.

2. **Explain at the moment of failed expectation — and prevent it a moment
   earlier.** Three moments, in order (52986): the **@-typeahead** already
   knows the state — a dead agent's picker entry carries it (prevention);
   the **send-time inline line** stays as the fallback for paste/mobile;
   and for components a human never mentions (event- and schedule-triggered —
   two of three shipped first-party apps, 52987), the **presence state in the
   room** (surface 3's dot, made load-bearing) is the moment. A mention-only
   surface reaches a third of the fleet and none of ADR-001's
   EventHandler/ScheduledJob components.

3. **Health is a dimension, not a decoration — and calm is a tier, not a
   color.** Your Team gets **three** groups (52986): broken-by-construction
   (attention accent) / expectedly asleep (calm: timestamp + wake command, no
   accent) / working. Gone-dark escalates to attention only when mentioned
   while dark or dark beyond its own measured cadence. Two groups is a
   wall-of-red every morning for laptop fleets — cry-wolf decay,
   severity-as-decoration, the thing ADR-017 rejected.

4. **Every bad state names its fix — for the runtime class it's on.** The
   original brief attached `commonly agent run <name>` to Never-connected;
   for native runtime there is nothing to run — a wrong instruction is worse
   than an accusation (52989). Fix text derives from
   (state × runtime class × viewer-is-owner).

5. **One accent stays one accent — and one derivation feeds every surface.**
   The ok/attention/broken tokens land in tokens.css + v2.css together and
   are used only here. The **showcase liveness affordance consumes the same
   states** (52986): `isShowcaseWorthy` currently drops model-failure banners,
   so public rooms render outages as silence — a deferred surface is fine, an
   unnamed twin is not.

6. **Honest, not alarmist — and never over-promising.** Copy certainty must
   match signal certainty (52986): structurally-certain states speak in flat
   declaratives ("isn't connected"); inferred states hedge temporally
   ("hasn't checked in for 3h; may answer when it wakes"). Render once per
   state-episode — persistence, not repetition (ADR-017). And the drafted
   send-time copy was itself dishonest: "it can't see this *yet*" promises
   eventual delivery, but pending mention events are GC'd at ~30–40 minutes —
   a Gone-dark agent waking later never sees the mention. Either mentions to
   bad-state agents are **parked and redelivered on reconnect** (a queue-policy
   change, decided below), or the copy states the real contract. zh-CN from
   day one, unchanged (every confused user that week wrote Chinese).

## Surfaces, in priority order (revised)

1. **Mention-time explanation, dependency-keyed** — compose-time typeahead
   state + send-time inline line, two copy variants (owner: fix; non-owner:
   attribution). Still the surface that would have saved every named user.
2. **Your Team restructure** — three state groups, fix-attached per runtime
   class, live-updating.
3. **Pod inspector presence dot, made load-bearing** — the dependency-keyed
   state for event/schedule components; detail on the agent profile.
4. **Nav-rail notifier** — imports ADR-017's hold≠interrupt verbatim: the
   badge is a hold, persists until resolved, never pings on routine
   Gone-dark; a one-time nudge only for Never-connected and Misconfigured
   (the product's broken promise, not the user's closed laptop).

Considered and deliberately deferred: email/push (retention plan territory);
the showcase affordance ships when the tokens do, as a consumer, not a fork.

## Decisions for ratification

1. **Accept the split key** (alarm=ownership, explanation=dependency) —
   recommended; nothing else in the brief coheres without it.
2. **Queue policy for mentions to bad-state agents:** park-and-redeliver on
   reconnect, or honest copy about the ~30-min window. (Copy is the cheap
   v1; parking is the better product and a kernel change.)
3. **Add Unreachable to the v1 table** — recommended; static, cheap, catches
   the class every other row misses (#898 implements the producer half).
4. **Route capture in `agentRuntimeAuth`** — one field on an existing write;
   unlocks Degraded for every outbound-authenticating class.
5. **Test-debris exclusion** for fleet-level state counts.

## Process

The fleet review ran 2026-08-12 in the Sharpen pod (msgs 52986–52991) under
the 0.2.0 tone contract — it doubled as that contract's first live test
(verdict logged separately: the contract did not bind; deterministic wrapper
enforcement shipped as #894). Sam ratifies this revision; implementation is
sliced after that, surface 1 first.
