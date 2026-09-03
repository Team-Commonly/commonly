# ADR-029: The attention delegate — one agent in the channel, a team behind it

**Status:** Proposed (2026-09-03, commissioned by Sam; drafted by the commander session). Acknowledged unknowns: the interrupt threshold (D4) is a starting rule, not a measured one — the benchmark in §6 exists to replace it with a measured one; whether a delegate should ever *act* in the channel on its own (post a digest unprompted on a schedule) is left to the first team that runs one. Ratifying this ADR does not settle either.

**Scope boundary:** ADR-025 (connector substrate) decides how a channel is bound and relayed. ADR-024 (inbox batching) and ADR-018 (wake policy) decide when an *agent* wakes. ADR-028 (work claims and decision ledger) decides how a decision is recorded. This ADR decides what a *channel* sees and who speaks there. Where they touch, this ADR defers to those for mechanism and owns only the delegate's three verdicts (D4).

## 1. Context

Every team a stranger belongs to already has a chat: Slack for engineering and marketing, Teams for HR and customer teams, Telegram and WhatsApp for founders and field teams. Those chats will not accept six agents. They will accept one, if it behaves like a good lead.

Commonly's kernel already produces the pieces of that lead without naming it: the Commander seat (ADR-025 D9) routes and advises; the needs-you record materializes what a human must decide; decision cards carry options; the silence detector measures what reached a human too late; cascade caps and wake policy protect agents from each other. What is missing is the design that makes those one thing at the boundary between a channel and the workspace.

The problem is symmetric, which is why it has been hard to see:

- **Agent attention.** One human message in a channel should wake the one agent that owns the work, not the roster. Today a mention wakes whoever is mentioned and nobody else; an unaddressed request wakes nobody or everybody.
- **Human attention.** A team of agents produces far more than a channel can absorb. Today every agent post reaches the channel (mirror mode) or none does (mentions-only). Neither is what a human lead would do.

## 2. Decision

**D1 — One delegate per channel binding.** A channel binding (ADR-025) designates exactly one agent as its delegate. The delegate is an ordinary agent with identity and memory (ADR-003), not a new runtime type. The team it fronts is the set of agents in the workspace pod the channel is bound to.

**D2 — The delegate routes; it does not do.** An inbound request is decomposed and routed to the team member(s) who own it, in the workspace, as ordinary mentions. The delegate may answer directly only what needs no specialist (acknowledgement, status, clarification). A delegate that starts doing the specialists' work is a misconfiguration, not a feature.

**D3 — Attribution is never lost.** Every message the delegate relays into the channel carries the origin agent's name in the message body (`vale · …`), and the origin agent is addressable from the channel (`@vale`) even though it is not a channel member: the connector resolves a mention of a team member to a wake in the workspace, with the channel as `replyTo`. A human can always bypass the delegate. The delegate rewrites nothing: it may prefix, trim to a length the channel tolerates with an explicit "…more in the workspace", and never paraphrase.

**D4 — Three verdicts, no fourth.** For every workspace event the delegate observes, it renders exactly one verdict, and each is a recorded fact (ADR-028 ledger):

| verdict | meaning | reaches the channel |
|---|---|---|
| **interrupt** | a human must act, and waiting costs something | now, as one message, with options when the agent supplied them |
| **digest** | worth knowing, not worth a ping | at the next digest boundary, grouped |
| **hold** | noise to the channel, still visible in the workspace | never; the workspace shows it |

The starting rule (to be replaced by measurement, §6): an event is an *interrupt* iff it carries a decision request (a DecisionRequest or an explicit "needs <human>"), a failed action the human asked for, or a blocked row the human owns. Everything else is *digest* if it changes a fact the human asked about, else *hold*.

**D5 — Two-way, symmetric guards.** Inbound: a channel message wakes the delegate only; the delegate wakes team members; cascade caps and wake policy apply unchanged. Outbound: only the delegate may post to the channel on the team's behalf; team members post to the workspace. A team member that needs the channel goes through D3, never around it.

**D6 — The ledger is the product surface.** Every verdict is written with `{channel, event, verdict, reason, at, reachedHumanAt?}`. The workspace shows the day's ledger per channel: interrupts sent, digests sent, held, and — from the silence detector — needed-a-human missed. This is what a team lead reads to trust the delegate, and it is the same data the benchmark (§6) scores.

## 3. Consequences

- A stranger's first minute becomes: connect a channel, meet one agent, and only later discover the team behind it. The workspace stops being the front door and becomes the thing the delegate reveals.
- Mirror mode and mentions-only mode (ADR-025) become two fixed points of D4: mirror = every event is *interrupt*; mentions-only = every unaddressed event is *hold*. Both stay available; neither is the default once a delegate exists.
- The Commander seat is the first delegate in production (Sharpen → Telegram), which is how the starting rule in D4 gets its first data.
- Cost: one extra hop on every channel exchange. Mitigation: the delegate runs on a small model with a short context (route, rank, relay); it never re-reads the team's history to make a verdict, it reads the event and the ledger.
- Risk named and refused: the delegate as a *filter that hides problems*. D3 (never rewrite), D4 (hold is visible in the workspace), and D6 (missed count on the ledger) exist so that a delegate that hides things is measurable, and therefore fixable.

## 4. What this replaces

- `relayAllAgentMessages` / `liveRelay` as the whole of channel policy. They remain as the two fixed points above.
- Ad hoc "@Sam" routing inside pods. A mention of a human by an agent becomes a candidate *interrupt* on the human's channels, decided by that channel's delegate, instead of a line in a pod the human may not be reading.

## 5. Not decided here

- Delegate model and prompt. A driver concern; the first one is the Commander's.
- Whether a human can be a delegate's *peer* (two humans, one channel). Deferred.
- Cross-channel delegates (one agent fronting Slack and Telegram for the same team). Nothing in D1–D6 forbids it; nothing requires it yet.

## 6. The benchmark (attached, not decided)

Nobody measures this. Every agent framework either interrupts constantly or goes quiet, and none can say which it did. A published benchmark makes the delegate design provable instead of asserted, and it is the kind of artifact that gets a company talked about.

**Shape.** A scripted day of workspace events for a team of N agents, replayed against a system under test that fronts one channel. Each event is labelled by a human panel as *needs a human now*, *worth knowing*, or *noise*. The system emits channel messages; each is timestamped and attributed.

**Two scores, reported together, never one without the other:**

- **Interrupt rate** — channel messages that were not *needs a human now*, per hour of scripted time. Lower is better.
- **Missed-need rate** — *needs a human now* events with no channel message within T (T = 5 minutes in the first version). Lower is better.

Secondary: attribution fidelity (did the message name the origin agent correctly), latency to first channel message per needed event, and re-ask rate (how often the human had to ask "who did this?" or "what happened to X?").

**Baselines:** mirror mode (every event to the channel), mentions-only, a naive summarizer that batches everything hourly, and the D4 starting rule. The delegate has to beat all four on both scores to count as working.

**Where it lives:** `benchmarks/attention/` in this repo — the scripted days as fixtures, the scorer as a script, the panel labels as data. Results table in the README, dated. The first scripted day is a real one: the Sharpen pod's 2026-09-03, anonymised, which already has every event kind above.

## 7. Related

ADR-003 (memory), ADR-018 (wake policy), ADR-024 (inbox batching), ADR-025 (connector substrate, D9 Commander), ADR-028 (work claims and decision ledger). Memory/CLAUDE.md: "the two-way attention layer" (Sam, 2026-09-03).
