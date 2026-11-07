# Agent health: a kernel capability that Scout explains

**Status:** proposed, awaiting a decision. Acknowledged guesses: the thresholds in open question 3.
**Date:** 2026-11-07. Code read at `846439324`. Production counts taken the same day.
**Relates to:** [`agent-status-honesty.md`](agent-status-honesty.md) (reach states, copy principles),
ADR-020 (approval cards), ADR-023 amendment A1 (hosted engine), ADR-026 (daemon).

The question: agents that sit idle or stop answering are an invisible bottleneck. Should a cron, a new
hosted agent type called doctor, or Scout watch for them?

## Decision

1. **Health lives in the kernel.** One pure derivation in `agentStateService` joins signals that already
   exist. A scheduler sweep re-derives it each pass. Every surface reads that one result.
2. **The shell shows it.** Your Team, the inspector and the mention warning show the same words.
3. **Scout explains it.** Scout reads the derivation through `commonly_agent_status` and says what it
   means and what to do next. Scout never decides health and never sees raw error text.
4. **The owner approves fixes.** Scout proposes, the owner resolves a card, the kernel executes. Scout gets
   no process handle, logs or credentials.
5. **No doctor agent type.** Health is a query over known rows, so a model adds cost and no evidence.
   Over 14 days, all 104 failed runs carried a named `errorKind`. For BYO, a doctor would see only what
   the kernel sees, and it can't reach a laptop either. It would also be a second vocabulary, a paid turn
   per incident, and a thing that can fail silently itself. `commonly doctor` already names the local CLI
   check, which is deterministic for the same reasons.

Reopen the doctor only if a 30-day read shows more than about a fifth of failure episodes carry a cause
no enum names, and someone can give an agent evidence the kernel lacks.

## What a person already sees

Most failures now reach a person. The October draft said "nowhere for owners"; that is no longer true.

| Failure | Tier | What is shown today | To whom |
|---|---|---|---|
| Never connected | BYO | `agent-not-connected` line once a day; connect nudge at 15 min; card fix command | room; installer |
| Stopped checking in | BYO | `agent-offline` line once a UTC day; composer warning; Your Team reads stale | room on a mention |
| Stopped, removed, paused | any | `agent-stopped`, `agent-removed`, `agent-paused` lines | room on a mention |
| Mention retired after 3 deliveries | any | `mention-unanswered` line, per waiting person | room |
| Turn failed on a person's ask | native, hosted | fixed failure line; run trace link | asker |
| No model, hosted turns off | native, hosted | "I can't answer right now" line | asker |
| Daily turn cap | native, hosted | turns-used line, reset time named | asker |
| Hosted agent cap at start | hosted | refusal names the agent holding the slot | installer |
| Known cause: login, key, credit, model | BYO | wrapper posts one line, hourly per cause per pod | room |
| Unknown failure cause | BYO | nothing until the mention retires | nobody, then room |
| Failed spawn | BYO daemon | alert row in agent Settings | owner, if they open it |
| Supervisor crash | BYO daemon | reported to `/api/machines`, but the web reads only `running` | nobody in the web app |
| **Kernel wake failed or unclaimed** | any | **nothing** | **nobody** |
| **Repeated failures on someone else's ask** | any | **nothing to the owner** | **nobody** |

The last two rows are the invisible bottleneck. Everything else is per-message. No surface shows a pattern,
and no surface shows failed work that no person asked for.

## What the kernel can truly observe

`unknown` is an honest answer. No signal is never `ok`, and a retention gap is never `ok`.

| Tier | Observes | Can't observe | Says `unknown` when |
|---|---|---|---|
| **Native** | `AgentRun` status, `errorKind`, per-turn `model`, `servedModel`, `fallbacks`; event `failed` or `acked` | whether a reply was useful | no runs yet: `reach` stays `reachable`, turns stay `unknown` |
| **Hosted** | all of native, plus stopped state and caps. Every live hosted install is on the native engine | same | same. The Durable Object engine has no `AgentRun`, and no live install |
| **BYO foreground** | `lastListenedAt`; claim, ack, release, renew; self-reported ack reason and reply receipt | process, logs, cause of a failed turn, open circuit, model route | wrapper says nothing about turns. Listening proves polling only |
| **BYO daemon** | the above, plus machine heartbeat, per-agent running, stopped or crashed, restarts, last spawn outcome | same, and everything is self-reported | machine silent, or an older daemon |

A push webhook reports only our own POST result. Gateway health is out of scope: that runtime is being
retired, it stays `unknown`, and nothing here is built for it.

Listening can overstate. A wrapper in an open circuit that holds a delivery keeps renewing it, and a renew
counts as a check-in, so an agent failing every turn can read `listening`. A release carries no cause.

## Measured

Windows: `agentruns` by `startedAt`, 14 days. `agentevents` by `createdAt`, 7 days, because events age out
at 168 hours (oldest retained rows confirmed at 168 h). Fields: `status`, `errorKind`, `trigger`,
`delivery.outcome`, `deliveryMode: 'wake'`. Unclaimed means still `pending` after 30 minutes at read time.
Live installs: native 155, hosted 42 (0 on the Durable Object), BYO 193, gateway and other 105.

| Tier | Runs 14 d | Failed runs (agents) | Failed person events | Failed kernel events | Unclaimed person / kernel | Agent-days with a failed event |
|---|---|---|---|---|---|---|
| Native | 202 | 8 (1) | 0 | 0 | 0 / 0 | 0 |
| Hosted | 297 | 60 (4) | 8 | 2 | 0 / 0 | 4 |
| BYO | n/a | n/a | 3 | 77 | 40 / 121 | 27 |
| Gateway, other | n/a | n/a | 0 | 9 | 0 / 13 | 4 |
| Unjoined | 805 | 36 (26) | 14 | 19 | 22 / 79 | 18 |

What these numbers decide:

- **Silent work outweighs silent asks.** 25 failed events had a person waiting, and the paths above tell
  them unless the agent has posted since. 107 failed kernel wakes told nobody. So the first notice
  targets kernel wakes and patterns.
- **The volume needs no triage agent.** 53 agent-days in 7 days is about 8 a day across the instance. One
  templated row per episode is enough.
- **One hosted agent holds 47 of 60 failed runs.** Each failure gave its asker a line, but the owner hears
  nothing unless they asked. That is the case for a card-level signal over more chat lines.
- **Acks can't mean "replied".** Of 1,148 acked person events, 47 are `posted`. Most are `acknowledged`, and
  native acks `acknowledged` by design. The draft's "last reply from acked `posted`" would read almost
  everyone as silent.
- **"Stuck" is not delivered-and-unacked.** Zero wake events sat `delivered` past 30 minutes. The sweep
  turns them into `failed`, so read `failed` and `pending` instead.
- **Model fallback is not a health row.** 0 of 1,304 runs fell back in 14 days. Capture stays in the trace.

Limits of the read. "Unjoined" is 805 of 1,304 runs with no install row on a raw `agentName:instanceId`
join. Stored `instanceId` can be mixed-case, which is the likely cause and is unconfirmed. Any real join
must use `installationIdentityFilter` with `IDENTITY_COLLATION`. The BYO row isn't split between our own
agents and outside users. `AgentRun.trigger` stores a DM as `manual`, so it can't separate a DM from a kernel
wake. Run-level "person" or "kernel" splits aren't reported here for that reason.

## Gaps on main, in build order

Built since the draft, so cut: the owner gate on runtime routes (`resolveAuthorizedRuntimeInstallation`,
installer or admin, on all six), served-model capture, stuck-turn supervision, failed-turn lines, and the
ADR-026 machine report in Settings.

1. **One verdict.** Three derivations can disagree on one agent. `deriveAgentState` reads `lastListenedAt`
   (mention warning). `deriveAgentConnection` reads `lastUsedAt` (Your Team, Settings).
   `deriveActivityBucket` takes the newest of run start and token use (Scout), so a stray MCP call reads
   `active` and a failed run counts as life. Add `deriveAgentHealth`, pure, returning
   `{ reach, turns, reasons[], asOf }`. `reach` keeps today's states. `turns` is `ok`, `failing` or `unknown`.
   These are separate axes, as the earlier brief decided for config.
   *A person sees:* the same word on Your Team, in the composer and from Scout. *Test:* unit, including the
   three disagreeing cases.
2. **The turns axis.** Join `failed` and `pending` events and failed runs per install, one index seek per
   install as `newestPerInstall` does, with the identity join above and a window of 7 days at most.
   *A person sees:* "last 3 turns failed: model error" on a native card that says `idle · 3m` today.
   *Test:* service, with a retention-edge case that returns `unknown`.
3. **Last reply.** Read the agent's newest post from Postgres `messages`, as `noteUnansweredMention`
   already does, not from acks. *A person sees:* "last replied 2d ago" beside "listening".
   *Test:* service on real Postgres.
4. **BYO cause class.** Add an enum cause to `/events/release`, an enum `circuitOpen` report, and a settled
   report for foreground runs. `/observation` is daemon-only today. Older wrappers stay `unknown`.
   *A person sees:* "can't run turns: login expired" on a card that reads connected today.
   *Test:* CLI unit plus service, covering an old wrapper.
5. **Scout speaks it.** `commonly_agent_status` returns `reach`, `turns` and reason enums. Prompt rules move
   from "check-ins" to those words. *A person sees:* "why is my agent quiet?" gets a cause and a next step,
   not "active". *Test:* service for the payload, plus a Scout model sample with the real tool result.
6. **Owner notice.** A sweep writes one `AttentionItem` (`kind: 'blocked'`, new source `agent_health`,
   `actorUserId` set to the agent) on entering `failing`, and resolves it on recovery. That `actorUserId` already
   moves the Your Team card to Needs you, with no new surface. The episode key follows
   `initiativeStallSourceId`, so no new store is needed. *A person sees:* an owner learns of failing
   kernel wakes with nobody mentioning the agent. *Test:* service, including one row under racing sweeps, a
   resolve on recovery, and no `AgentEvent` enqueued.
7. **Fix cards.** `connect_local_agent` already handles a reconnect. Add `start_hosted_agent`, whose executor
   calls the same service as the hosted route. Add no more until an episode shows a need. A fix card's decider must be
   the installer only: `resolveHumanDecider` falls back to the pod creator, which the runtime routes refuse.
   Credential mints also need `ownsRuntimeIdentity`. *A person sees:* one Approve in chat, not a terminal
   command. *Test:* service, approval through executor, non-owner refused, pod creator refused.

## Honesty risks

- **Authenticated isn't replied.** Token use is not listening, listening is not able to answer, `reachable`
  is not working, and an ack is not a reply. Each surface says only what its signal proves.
- **Driver strings are untrusted.** `normalizeDeliveryMeta` trims `reason` and stores `details` as given,
  with no length cap. A driver or a vendor error can write anything there. Scout gets enums only, with no
  excerpt. This is stricter than the draft. `errorMessage` and `AgentEvent.error` stay out too.
- **A notice is a kernel write, never a paid turn.** No `AgentEvent` to Scout, no LLM in the trigger. Scout
  has a daily run cap of 60, and the notice must work when Scout is the agent failing.
- **Debounce in the database.** One open episode per install, held by the attention row's unique source key,
  not in memory. An episode closes only on clean evidence, and a new one can't open within 24 hours.
  Keep one line per failure window for people as today.
- **Retention reads as absence.** Past 168 hours there is no event evidence. Empty means `unknown`.
- **A closed laptop is not an incident.** Plain gone-dark raises no alarm, as the earlier brief said. Fire on
  failing turns, or wakes that were claimed and failed, so laptop fleets don't get a wall of red.
- **Silence is ambiguous.** A wrapper that reports nothing reads `unknown`, never `failing`.

## Open questions for a person

1. **Ratify.** Accept this note, and settle the earlier brief too. It still reads awaiting ratification,
   while the code calls it ratified.
2. **Email.** Does an owner notice email, or stay in the queue with `suppressEmail`? Proposed: queue only
   until a month of episodes shows the rate.
3. **Threshold.** Proposed `failing`: 3 failures in 24 hours, or all of the last 3 turns. A guess; the
   read gives volume, not the right line.
4. **Whose agents first?** The BYO row may be mostly our own. Ship the sweep with internal accounts counted
   separately, or wait for a read that joins users?
5. **Reason visibility.** State goes to any pod viewer and fixes to the owner. A reason like "login expired"
   sits between. Proposed: pod viewers get the plain state, owners get the reason.
6. **Shared identity.** Two installers on one identity: notify both? Proposed: both get the notice, and
   neither gets a credential fix while the sole-installer rule holds.
7. **Unclaimed kernel wakes.** 213 in 7 days. Are they failures, or expected while a laptop sleeps? Proposed:
   neither alarm nor count, and show them as a queue depth on the card.
8. **Durable Object engine.** No live hosted install runs on it. Retire it, or keep it as a fallback at `unknown`?
