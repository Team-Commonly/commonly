# ADR-028 — Work claims and the decision ledger: recording custody, work area, and why

**Status:** **Draft, with one ratified doctrine folded in.** Opened at Sam's request (2026-08-31
kickoff). **D1–D7 remain proposals and nothing in the audit is ratified.** What *is* ratified is the
attention doctrine in §Ratified doctrine (Sam, 2026-08-31) and the consequences it forces, carried
below as **D8–D11** — D11 being the kill-criteria instrumentation Sam required at acceptance. Read the split literally: Sam ruled on where a decision is *rendered*
and what it costs the human, not on what a claim records or where the ledger lives — those are still
the open questions at §Ratification points, and D8–D10 do not presuppose an answer to any of them.

**Build is no longer gated on customer interviews.** A previous revision of this line said "build
waits for the five customer interviews"; **Sam rescinded that on 2026-08-31 (pod 61474) in favour of
ship-and-measure**, and the sequencing is now at §Sequencing and acceptance. The instrumentation
required there (D11) is what answers the questions the interviews were going to.

One section is deliberately unfilled: the competitive comparison, because the evidence pack behind it
is operator-held and not readable from this seat (see §Evidence I could not verify).
**Date:** 2026-08-31
**Method:** current-state audit measured on `origin/main` at `4d177817` (2026-08-31T02:34:30Z); the
decisions are proposals, the findings are measurements.

**Scope boundary — read this before citing ADR-018 or ADR-024 against this document.**

- [`ADR-018`](ADR-018-agent-attention-claims.md) owns the **message** claim: what a claim is, that it
  is a lease, and who may speak. This ADR does not re-open any of that. It adds the two things
  ADR-018 does not carry: what a claim says about **where work is happening**, and what it records
  about **how the claim ended**.
- [`ADR-024`](ADR-024-shared-awareness-and-the-agent-inbox.md) owns awareness of *messages*. This ADR
  is about awareness of *work and decisions* — a different store, read at a different moment (before
  work starts, not on delivery).
- [`ADR-027`](ADR-027-pm-tool-projection-contract.md) (Wren) owns how a structured work item
  **projects** across a tool boundary — a pod's board ↔ an external PM surface. This ADR owns what
  the work item **records in the first place**: the claim's work area, and the decision behind it.
  They are siblings and the dependency runs one way — the ledger is what the projection projects, so
  a field this ADR does not require is a field ADR-027 cannot carry across. Numbered 028 because
  ADR-027 was filed three minutes earlier and both drafts took the same number (Sam, 2026-08-31).
- [`ADR-017`](ADR-017-attention-routing.md) owns routing to the **human**. The audit and D1–D7 route
  only between agents. **D8–D10 are the exception and they are deliberate**: the ratified doctrine
  puts a claim/decision event onto ADR-017's existing routing layer rather than beside it, so this
  ADR now *consumes* ADR-017 and must not grow a second router. Two consequences of that dependency
  are recorded at D8 rather than left to be discovered: ADR-017 is **`Proposed`**, so D8's
  *classification* substrate is unratified, and the doctrine's phrase "attention threshold" names a
  mechanism ADR-017 explicitly rejected.
- [`ADR-020`](ADR-020-admin-guide-delegated-authority.md) is **`Accepted`** and implements ADR-017's
  card (its D3). It owns the surface on which a decision is *rendered*, and its structured message
  `payload` is what D8 migrates onto. **Named here because the adjacent-ADR trap is on record**: this
  document would otherwise be read as depending only on a `Proposed` ADR, when the rendering half it
  needs is already ratified. This ADR adds no card and no second lifecycle.
- [`ADR-003`](ADR-003-memory-as-kernel-primitive.md) owns memory. A decision ledger is not memory: it
  is shared, addressable, and append-only, where memory is private and rewritable.

---

## Ratified doctrine (Sam, 2026-08-31)

> **We route attention, we do not compete for it.**

External messaging apps remain the human attention layer. The ledger owns the **decision moment** —
gate approvals, claim-conflict resolution, and the what-my-agents-did-and-decided digest are rendered
**only in Commonly** and reached by link from the external app.

Ratified verbatim by Sam in the sprint pod (2026-08-31), with a standing constraint that binds every
decision below it: **no new notification system, and no per-user routing UI in v1.**

This is the doctrine D8–D10 implement. It settles a question the rest of this ADR had left implicit —
whether a decision ledger should push. It should not. Everything downstream of it is a link.

*Scope of the ratification:* the doctrine and its three consequences. It does not ratify D1–D7, and
it does not choose D5's container — a link needs something addressable to point at, but "addressable"
is satisfied by either candidate at §Ratification points 1, so the doctrine survives either answer.
D11 and §Sequencing come from a second Sam ruling the same day (61474) and are ratified on the same
footing; they are separated here only because they answer a different question.

---

## Context: code preserves the result, not the reasons

A repository is a perfect record of what was decided and a near-total loss of why. The commit that
landed carries no trace of the three approaches ruled out before it, the measurement that killed the
obvious fix, or the constraint that made the ugly shape correct. Every subsequent reader — human or
agent — either re-derives that reasoning or, more often, re-derives the *rejected* option and ships
it again.

This fleet has produced the evidence unprompted, in the repo, this week:

- **A ruled question is re-asked because the ruling has no queryable home.** Sam ruled TASK-067 on
  2026-08-26 and restated it 2026-08-28; the row's `title` still reads `DECIDE (Sam): …`, and the
  board wake quotes the title. A seat re-asked the settled question six hours after the second
  ruling. The ruling exists only as prose in an update log that no predicate reads.
- **Two agents wrote the same finding four days apart.** AX audit entry 49 (#1325) re-derived a
  surface #1234 had had open since 2026-08-25. Neither PR conflicted with the other — one inserts
  mid-file, one appends at EOF — so nothing went red to tell the reviewer that two entries covered
  one surface.
- **`main` has carried two files named `ADR-018` for 22 days.** `ADR-018-agent-identity.md` (merged
  2026-08-04) and `ADR-018-agent-attention-claims.md` (merged 2026-08-11). Disjoint filenames share
  no text to conflict on, and `docs/adr/` has no index, so the collision is invisible by
  construction.
- **A conflict resolution was silently discarded, twice in one hour.** #1291 was rebased out from
  under an EOF merge resolution; the only symptom was the PR going `DIRTY` again. Nothing names the
  lost work, because nothing recorded that the work existed.

None of these is a coordination failure by an agent. Each is a **missing record**: work in flight is
not addressable, and a decision is not a first-class object.

---

## Current state, measured on `origin/main` at `4d177817`

**Finding 1 — A task claim records custody and nothing about the work.**
`backend/models/Task.ts` carries `claimedBy`, `claimedAt`, `claimExpiresAt`, `rescueDeferrals`,
`lapsedFrom`, `assignee`, `prUrl`. There is no branch, no worktree, no base sha, and no set of paths.
So a claimed row answers *who* and *until when*, and cannot answer *where*. Two seats can claim two
different rows whose work is the same file and nothing anywhere knows.

**Finding 2 — `prUrl` is already writable on a claimed row, and no row on this board has ever
carried one.** Corrected twice after @sprint-review's gate on `e409a2f2`; the
first draft said the field was write-once at completion, and that is false at the route.
`PATCH /api/v1/tasks/:podId/:taskId` allowlists `prUrl` with **no status gate**, and the router's own
`auth` shim sends any `cm_agent_*` bearer to `agentRuntimeAuth` — so an agent can write `prUrl` while
its row is `claimed`, today. The openclaw extension exposes that route as a tool and its description
says so in as many words: *"Use to reassign, mark blocked/unblocked, or link a PR."*

The MCP tool surface has **no PATCH tool at all**. `commonly_complete_task` is the only MCP tool that
accepts `prUrl`, its description defines it as *the merged PR*, and it posts to `/complete`;
`commonly_update_task` takes `{podId, taskId, text}` and posts to `/updates`; `commonly_claim_task`
takes neither.

**The tool gap does not bound what a seat can do, and the draft's second version said it did.**
@sprint-review's own seat is MCP and has written `prUrl` with a direct `curl` against the route; a
runtime token plus an HTTP client is the escape hatch, so the missing tool shapes the *default path*
and not the capability ceiling. The measurement that survives without any premise about which runtime
a seat runs is the whole board: of 94 rows, **47 carry a `prUrl` and all 47 are `done`** — zero on
`claimed`, `blocked`, or `pending`, across every seat and every runtime that has ever written to it.
The field is populated at completion and never before, which is what `commonly_complete_task`'s
description teaches (*"`prUrl` is the merged PR"*) and what the openclaw patch tool's description
contradicts (*"Use to reassign, mark blocked/unblocked, or link a PR"*).

So the defect is not the data model, and it is not a hard capability boundary either. It is that the
route allows a write that one runtime's tools name and describe, the other's do not expose at all, and
the two descriptions disagree about what the field means — so a state the store can hold, "built,
open, waiting on a press", has never once been recorded, and a peer reading `prUrl: null` off a
claimed row correctly reached the opposite of the truth and said so in the pod.

**Finding 3 — The context an agent reads before working contains no claims and no decisions.**
`GET /api/agents/runtime/pods/:podId/context` returns, via `PodContextService.getPodContext`:
`pod, members, files, recentMessages, task, stats, skills, tags, summaries, assets`. The `task` key is
the **caller's own free-text query string**, used for keyword ranking — not a board row. There is no
board, no claim, and no decision in the payload. An agent that does exactly what the platform tells it
to do before starting work learns nothing about what its peers are already doing.

**Finding 4 — The claim table records custody and not disposition.** `message_claims` has five
columns: `message_id, pod_id, claimed_by, instance_id, expires_at` (+ `created_at`). Nothing records
how the claim ended. `MessageClaimService.release` is called from exactly two non-test sites —
`routes/agentsRuntime.ts:356` (the explicit `commonly_release_claim` route) and
`nativeRuntimeService.ts:828` (turn-end cleanup, unconditional). Neither distinguishes *released after
answering* from *released after passing*. **"I handled it" and "I looked and chose silence" are the
same row.**

**Finding 5 — A task update has no kind and no supersedes.** `ITaskUpdate` is
`{text, author, authorId, createdAt}`. A ruling, a status note, a measurement, and a retraction are
the same shape, so nothing can query "what was decided here" or "what did this overturn". Finding 1's
TASK-067 re-ask is the direct consequence.

**Finding 6 — #1394 is not an unruled question. It is a ratified decision that was never built.**
ADR-018 **D6.1**, amended 2026-08-14 and inside an Accepted ADR, already rules it, verbatim: *"On a
`message.posted` (broadcast) trigger, a `NO_REPLY` verdict **releases the claim for a bounded second
pass** rather than consuming the message. A targeted `chat.mention` keeps D6 unchanged — there the
claimer *is* the addressee, and its silence is the answer."* D6.1 was
written from an observed 2026-08-14 incident with the identical shape to #1394's 2026-08-30 one.

Measured: **nothing anywhere in `backend/` re-offers a passed message.** A grep for a re-offer, a
second pass, or a D6.1 reference across `backend/services` and `backend/routes` returns nothing but an
unrelated comment in `onboardingSilenceService.ts`. And releasing the claim could not implement D6.1
on its own even where it happens: `enqueueWakeOnMessage` (`agentMentionService.ts:1254`) enqueues
**one `message.posted` event per wake-eligible install**, so the peer seats that stood down have
already consumed their own events.

**Corrected after @sprint-review's re-gate, and it narrows the finding.** The first draft cited `:957`
— that is the loop-guard `countDocuments`, not the enqueue — and said the machinery is absent. The
*exclusion* half is not absent: `enqueueWakeOnMessage` skips any seat in `excludeKeys` (`:1240`), and
one of its two call sites already passes a populated set (`:1757`, `enqueuedIdentityKeys`; the other,
`:1395`, passes `null`). So a re-offer that omits the seats which already passed is a **caller**, not
new machinery. What is genuinely missing is the trigger: nothing computes a passed-set or re-enters
the fan-out with it.
Freeing the lease reaches nobody. The native tier's unconditional release at
`nativeRuntimeService.ts:828` is therefore not an implementation of D6.1 — it frees the lease and
re-offers nothing.

> **The generalisation, which is this ADR's thesis:** five of these six findings are the same defect.
> A claim, a board row, and an update each record **what state we are in** and never **what was done
> or decided, by whom, and against what alternative**. The store keeps the result and drops the
> reasons — exactly the property the manifesto line names in code, reproduced one layer up in our own
> coordination substrate.
>
> **Finding 2 is the exception and this draft has over-claimed it twice.** It first said six of six;
> the gate found the store already holds what Finding 2 asked for. The correction then explained the
> emptiness by a runtime census, and the same reviewer falsified that too — an MCP seat has written the
> field by `curl`. What is left is narrower and measured rather than inferred: the write is allowed,
> the two runtimes' tool descriptions disagree about what the field means, and 47 of 47 populated
> `prUrl` values on this board sit on `done` rows. It is left standing rather than folded in, because
> a thesis that absorbs its own counterexample is not one.

---

## Decisions

**D1–D7 are proposals for Sam. D8–D11 are ratified** — D8–D10 are the attention doctrine's
consequences and D11 is the instrumentation Sam required at acceptance. The only open thing about
them is when ADR-017 is ratified, so D8 has a substrate to build on.

### D1 — A claim carries a work area, written at claim time

Claiming a task records, on the claim: the **branch**, the **base sha** it was cut from, and the
**paths the claimant expects to touch**. Written when the claim is taken, revisable while it is held,
never inferred at completion.

Rationale, and the reason it is `paths` rather than a lock: the collisions this fleet actually hits
are not two seats editing one line — git already reports those. They are two seats editing one
*file* at different offsets (the AX-audit EOF case, which merges clean and ships a duplicate), or one
seat pushing to another's branch. A path list makes both visible at read time. It is an
**advisory** record, not a mutex: this ADR proposes nothing that can refuse a write.

### D2 — The MCP tool surface exposes the `prUrl` write that already exists

Not a data-model change and not a new capability — the route allows it now. The proposal is to reach
it: give the MCP tool set the same field-patch verb the openclaw extension already has, or widen
`commonly_update_task` to carry the allowlisted fields, so an open PR is recordable from either
runtime the moment it exists. (ADR-017's `blockedOn` work made the parallel move for the blocked side;
this is its twin, one layer out — there the field was missing, here only the reach is.)

The rule under it generalises past `prUrl`, in its survivable form: **a kernel capability is not
shipped until every runtime's tools name it.** The stronger form — *until every runtime can reach it* —
is false here and was in the second draft: a seat holding a runtime token can always reach the route
with an HTTP client, and one has. What the missing tool actually costs is the default: a field
allowlisted on a route and absent from a runtime's tool set is, for every agent that works through its
tools, a field that does not exist — and the 47-of-47 measurement above is what that costs in practice.

### D3 — The context read surfaces active claims and recent decisions

`getPodContext` gains two sections: **active claims** (who holds what, until when, with D1's work
area) and **recent decisions** (D5's records, most recent first, bounded). Both bounded and both
inside the existing token budget.

This is the decision that makes the other six findings *reachable*. A record nobody reads before
starting work is a record that does not exist, and Finding 3 says the platform's own
"read your context first" path currently teaches an agent that nothing is in flight.

### D4 — A claim records its disposition, not only its custody

A claim records a disposition: **answered**, **passed**, or **expired** (the last being the absence
of a release, not a value anyone writes).

**This is NOT one column on `message_claims`, and an earlier draft of this decision said it was**
(sprint-review, pod 61596). That table is current-state only, by three separate mechanisms, all
verified on `origin/main`:

- **`release` is a `DELETE`** (`MessageClaimService.release`). So a `passed` disposition is erased by
  the declining seat itself, one call later, on the path the code calls normal: the route comment at
  `DELETE /messages/:messageId/claim` reads "claim-then-decline is a normal, frequent path per D6".
  No second seat is needed to lose the record — the seat that writes it destroys it.
- **`message_id` is the PRIMARY KEY.** The table can hold at most one claim per message, ever, so it
  cannot represent D6's re-offer at all: a re-offer is a *sequence* of claims on one message, and the
  CAS's `ON CONFLICT DO UPDATE` overwrites `claimed_by` in place.
- **Renewal sets `created_at = NOW()`.** A holder that follows its own instruction destroys the age
  of its own claim, which is the same shape as the deferral counter zeroed by the event that makes it
  meaningful.

So D4 needs an **append-only claim-event record** — one row per (message, seat, disposition) — not a
column. That is a larger ask than the first draft priced, and it is the honest price: the smallest
thing that fits on the existing table cannot survive the ordinary path.

**Widening, on a surface neither of us raised: main already depends on the persistence this table
does not have.** `OnboardingSilenceEpisode.ts` names `message_claims.claimed_by` as *the*
discriminator between "the runtime declined at its daily cap" and "another agent won the claim and
this seat stood down" — two zero-run faults with opposite investigations — and defers reading it as
"a bigger change than a label". The change is bigger than that comment thinks: an episode is
diagnosed after the fact, and by then the winner has released, so the discriminator it names is
already gone. A shipped diagnostic is pointed at a row that does not outlive the turn.

This is still the precondition for D5 — you cannot ask "what did this pod decide" of a store that
cannot say whether anyone did anything.

### D5 — Decision records are a typed object, and superseding is explicit

A decision record carries: **what was decided**, **what was attempted or ruled out and why**, **who**,
**when**, and **what it supersedes**. Append-only; a superseded record is never edited or deleted, it
is pointed at by its successor.

Where it lives is D5's open half and is a ratification point below: the board row's update log
(cheapest, already exists, already the place Sam rules) versus a pod-scoped ledger addressable
independent of any row. The argument for the row is that rulings already arrive there. The argument
against is that the ADR-018 duplicate-number case and the #1291 rebase were not about a row at all.

### D6 — `NO_REPLY` on a broadcast re-offers once; the ruling is ADR-018 D6.1 and this ADR only builds it

No new rule. D6.1 is ratified and unbuilt; #1394 is its second observed instance. What this ADR adds
is the mechanism Finding 6 shows is missing, and its bound:

- A disposition of **passed** (D4) on a **broadcast** trigger re-offers the message **once** to the
  wake-eligible seats that have not already passed on it. Once. No cascade — a re-offer that is
  passed again is done.
- A **targeted** `chat.mention` is unchanged: there the claimer is the addressee and its silence is
  the answer. This is D6, and D6 is right.
- The re-offer must be a **new event per remaining seat**, because `enqueueWakeOnMessage`
  (`agentMentionService.ts:1254`) already fans out per install. Releasing the lease is not sufficient
  and never was.
- **This is a caller, not new machinery.** The same helper already takes an `excludeKeys` set and
  filters on it (`:1240`), and `:1757` already passes one. Building D6.1 means computing the
  passed-set and re-entering `enqueueWakeOnMessage` with it — so the implementation cost is a third
  call site, which is a materially smaller ask than the first draft implied.

Third arm, from #1394's own suggestion 3 and worth ruling separately: the human should be able to see
**"seen by 5, answered by 0"** rather than nothing. `agentDelivery` already knows the fan-out. A
re-offer that also fails is still an answer to the human, if it is visible.

### D7 — The ledger is advisory everywhere; nothing here can refuse a write

No claim, work area, or decision record may block a push, a merge, an edit, or a post. Everything in
this ADR is a **read-time** signal. The claim layer's own history is the argument: the kernel never
refuses an unclaimed post (ADR-018 D3), because "forgot to claim" must not become "agent is silent".
The same reasoning applies with more force to work: "forgot to record a work area" must not become
"cannot ship".

---

### D8 — A claim or decision event classifies on the existing routing layer, and adds no second one

A claim/decision event is routed by the same machinery that already routes any wake event. It is not
a new feed, a new store, or a new subscriber list. This is the operative half of "no new notification
system": the cost of surfacing a decision must be the cost of one more event class, not the cost of a
router.

**Two corrections to the mechanism as named, recorded here so neither is inherited as fact.** The
doctrine cites "the attention threshold … (ADR-018 machinery)". Measured on `origin/main`:

1. **The machinery is ADR-017's, not ADR-018's.** ADR-018 disclaims the direction in its own text —
   "ADR-017 covers agent→human escalation only. Agent↔agent coordination has no …". ADR-018's only
   threshold is D6.3's consecutive-silence convergence counter, which is a loop bound between agents
   and not a routing decision about a human. Citing "ADR-018's attention threshold" as the substrate
   for D8 would point an implementer at a mechanism that is not there.
2. **"Threshold" names the thing ADR-017 rejected.** ADR-017 Layer 2 rules *"Classes, not scores.
   Scalars are miscalibrated and thresholds rot"* — routing is by **class**, budgeted and muted as a
   class. So D8 is built as a divergence/decision **class** on ADR-017's taxonomy (which carries an
   `other` + free-text escape valve for exactly this case), not as a score compared against a cutoff.

Sam's intent is unambiguous and is what is ratified: reuse, don't build. The two corrections change
which file an implementer opens and which shape they build; they change nothing about the ruling.

**Third correction, and it is about capability rather than citation (@sprint-review, 2026-08-31).**
"Classifies like any wake event" reads as a platform property and is currently **one connector deep**.
Measured on `origin/main`: `shouldEscalate` is *defined* once and *called* once, both inside
`backend/services/telegramBridgeService.ts` (`:64`, `:137`). Discord and Slack services exist
(`discordService.ts`, `discordGatewayService.ts`, `slackApi.ts`) and carry **no escalation gate at
all**; WhatsApp and X have none either. So D8 reuses a mechanism that today reaches exactly one
external surface.

This does not weaken the doctrine — the doctrine says route, don't compete, and routing to one
surface is still routing. It sets the honest expectation: **on every connector but Telegram, D8's
"classify" step has nothing to classify against yet**, and building the missing gates is connector
work this ADR does not own and must not silently assume. Recorded here so "reuse the existing layer"
is not read as "the existing layer already covers the fleet".

**Fourth correction, and this one is a build constraint rather than a caveat (@sprint-review, 2026-08-31).**
The existing gate **cannot classify an event at all.** Its signature is
`shouldEscalate({ content, agentUsername, integration }) => boolean` — a **string**, an agent
identity, and a config. There is no event parameter and no type field, so *"a claim/decision event
classifies like any wake event"* is not directly buildable: **a new event type has nothing to present
to the classifier.** What the gate matches is a bracketed literal in the content:

```
ESCALATION_MARKERS = /\[(BLOCKED|ESCALATE|DECISION|NEEDS[-_ ]?HUMAN|APPROVAL)\]/i
```

**`DECISION` and `APPROVAL` are already in that set.** So "no new notification system" holds exactly,
and by a narrower path than it first appears: a claim or decision reaches the human **iff it surfaces
as a pod message whose content carries one of those markers.** No code change is required for the
markers themselves; the requirement lands on the *producer*.

**The call site narrows it once more** — `relayAgentMessageToTelegram` has exactly one caller,
`AgentMessageService.postMessage` (`agentMessageService.ts:1746`). So the surfacing contract is not
merely "a pod message with a marker" but **an agent-authored pod message posted through
`postMessage`**. That matters for one of the three surfaces the doctrine names: **claim-conflict
resolution is the case most likely to be kernel-authored** — a lease expiry, a sweep, a conflict the
kernel settles with no agent speaking — and a kernel-authored record traverses no path to this gate.
Gate approvals and the digest are agent- or read-shaped and do not have this problem. **So D8 is
implementable today for two of the doctrine's three surfaces, and the third needs a producer that
does not exist yet.** Stated rather than discovered during the build.

**This is not a Telegram quirk — it is the current shape of the whole decision surface.**
[`ADR-020`](ADR-020-admin-guide-delegated-authority.md) D3 records the same thing about approval
cards: *"today neither store has a metadata column and every 'card' is a regex sentinel in the
content string."* Two independently-built decision surfaces both key on a content string, for the
same reason. **And the replacement is already ratified**: ADR-020 is **Accepted**, its D3 gives
messages a real structured `payload` in both Mongo and PG, and that payload is precisely what would
let a claim/decision be a typed object instead of a sentinel. **D8 should therefore be built on the
marker today and migrate onto ADR-020's payload when it lands** — a stopgap whose successor is
already decided is not technical debt, and picking the sentinel now costs nothing later.

**Correction to this ADR's own earlier framing, and to what I told Sam in the pod (61578).** I wrote
that nothing in the doctrine can be built until ADR-017 is ratified. **That is too strong.** It is
true of D8's *classification* layer — ADR-017 is `Proposed` and owns the class taxonomy. It is false
of the *rendering* half, which is the doctrine's core claim: ADR-020 is **Accepted** and D3 states
"the approval card IS ADR-017's card, implemented", with the ADR-017 lifecycle
(`flagged → resolved / expired / moot`) and its invariants — only a human writes `resolved`, retiring
a card is never an approval, fail closed. **So "the decision moment is rendered only in Commonly" has
a ratified home right now.** What is blocked is which events *reach* that surface automatically, not
whether the surface exists.

**The dependency is real, and narrower than I first stated (see the fourth correction below):**
ADR-017 is **`Proposed`** and its Layer 3.1 attention queue carries three explicitly undecided items,
so **D8's automatic classification** is ratified in *direction* and blocked in *substrate* — it cannot be built before ADR-017 is ratified, and building
it against an unratified spec is the failure mode CLAUDE.md's ADR-status discipline names. If
ADR-017's ratification changes the class taxonomy, D8 follows it; D8 does not get its own.

### D9 — Every externally-surfaced claim or decision carries a canonical ledger URL

If a claim or decision is visible anywhere outside Commonly, the surfaced artifact carries a link
back to the canonical record. The external copy is a **pointer, never the record** — it may be
truncated, stale, or rendered by a surface Commonly does not control, and the link is what makes that
safe. This is the mechanical half of "reached by link from the external app".

Consequence worth stating, because it is the constraint that bites first: **the ledger record must be
addressable before it can be surfaced.** Any container chosen at §Ratification points 1 must yield a
stable URL for a single decision. That is a requirement D9 places *on* that open question, not an
answer to it.

Consequence for [`ADR-027`](ADR-027-pm-tool-projection-contract.md): a projection into an external PM
surface is an external surfacing, so the projected item carries the ledger URL. The one-way
dependency already recorded in the scope boundary holds — this ADR requires the field, ADR-027
carries it across.

### D10 — The digest is a read over the ledger, not a store

The "what my agents did and decided" digest is computed from ledger records at read time. It does not
get its own table, its own write path, or its own retention rule. This is the third face of the
keep-it-simple constraint, and it is the one most likely to be violated by accident, because a digest
is the natural place to start caching.

The falsifiable consequence: **a digest must be reproducible from the ledger alone.** If a digest ever
needs a fact the ledger does not carry, that is a signal to add the field to the ledger (D1/D4/D5),
never to add a store beside it. D7 applies unchanged — a digest is a read-time signal and can refuse
nothing.

### D11 — Acceptance ships with kill-criteria instrumentation, and the criteria are named before the build

Ship-and-measure only works if the measurement is specified before the thing that would bias it.
**Sam named two instruments (pod 61474); both are required at acceptance, not after.**

1. **Is the ledger read before work starts?** The falsifiable form: for each claim, did a context read
   that surfaced active claims or recent decisions occur *before* the claim, or did it not. D3 is the
   surface being measured, so D3 and its instrument land together — a D3 that ships unmeasured cannot
   be killed, only argued about.
2. **Per-team board depth.** How many rows a team's board actually carries over time. This is the
   adoption signal: a ledger nobody deepens is a ledger nobody uses, and it is measurable without
   asking anyone anything.

**These are kill criteria, which means the failing case must be stated now.** If the ledger is
consistently *not* read before work starts, the defect is D3's surfacing or the read moment, not the
recording — and the response is to move the read, not to add fields. If board depth stays flat across
teams while claims keep flowing, the ledger is write-only and the thin core is wrong. Neither
conclusion is available later if the instrument is not there from the start.

**Instrument 2 is a read over data D1/D4/D5 already require. Instrument 1 is not, and an earlier draft
of this section said it was** (sprint-review, pod 61584). D3 changes what the context read *returns*;
nothing anywhere records **that it happened**. Verified on `origin/main`: `podContextService.ts`
contains no `updateOne` / `save` / `create` / `findOneAndUpdate` / `insert` call, and `contextReadAt`
/ `lastContextRead` / `lastReadAt` have zero hits across `backend/`. The read path is write-free by
construction, so no amount of D3 work makes the read observable — instrument 1 needs one field that
does not exist today.

Two shapes for that field, and the choice is load-bearing:

- **Server-stamped.** `getPodContext` writes a last-read timestamp per (agent, pod). Authoritative,
  because the seat does not author it. Cost: it makes a read path write, which is a real change to a
  hot route.
- **Claim-carried, self-reported.** D1's claim records the read it was taken after, on the claimant's
  word. Cheaper and touches no read path, but a self-reported field cannot falsify the claim it
  reports on — the seats that skip the read are exactly the ones whose self-report is worthless.
- **Server-stamped, claim-echoed.** `getPodContext` mints the stamp; D1's claim carries **the value
  it observed**. This is the one to build.

**Neither of the first two is sufficient, and an earlier draft of this section recommended the first**
(sprint-review, pod 61589). A per-(agent, pod) scalar holds only its *current* value, so the
comparison it supports is `lastReadAt < claimedAt` — true for every claim a seat ever makes after its
first read, on any seat, forever. It measures *has this seat ever read the ledger*, which is a
question with a ~100% answer and no failing case. Self-reporting fails for the opposite reason: the
value is falsifiable in principle and unfalsifiable in practice.

Echoing a server-minted stamp is what makes the criterion per-claim: the seat cannot author the
value, and the value is attached to the claim rather than to the seat.

**It inherits D4's substrate, not just D4's shape.** A stamp echoed onto the `message_claims` row is
deleted at release like any other field on it, so the kill criterion could only ever be evaluated
inside the lease — never retrospectively, which is the only time anyone asks. Instrument 1 and D4's
disposition want the same append-only record; build one.

**One consequence, not in the correction: a minted stamp with no expiry is a reusable token.** A seat
that reads once at boot and echoes that stamp on every subsequent claim passes the criterion exactly
as a compliant one does. The bound must not be a wall-clock window — that is an arbitrary knob nobody
can calibrate. Compare the echoed stamp against **the ledger's own last write to the rows the claim
contends with**: a claim is read-before iff the stamp is no older than the most recent conflicting
write it should have seen. Those timestamps are data D1/D4/D5 already require, so the bound costs no
new field.

It remains **one field, not a store** — D10 holds — and per D7 neither instrument can refuse a write:
an instrument that gates is not an instrument.

---

## Sequencing and acceptance (Sam, 2026-08-31 — pod 61474)

Interviews are not a precondition. The order Sam set:

1. **@sprint-review stamps the renumbered ADR-028** (this document, at its current head).
2. **The operator builds the thin core** — claims deriving work areas, decision records, and
   context-read surfacing. That is D1, D5, and D3 respectively; **D2 is the tool surface those need
   to be reachable through**, and D4's disposition vocabulary is the one open item inside the core
   (§Ratification points 4).
3. **Our own fleet dogfoods it first.**
4. **The biomed team is the first external offer** — their letter asked for a multi-agent-fit task
   board.

Two things this sequencing does not do, stated because a sequence reads like a settlement. It does
not ratify D1–D7: step 1 is a review stamp on a document that still carries open ratification points,
and D5's container (point 1) sits *inside* the thin core, so it has to be answered before step 2 can
start, not deferred by it. And it does not resolve D8's substrate — ADR-017 is `Proposed`, so the
routing layer D8 reuses is unratified independently of anything here.

---

## Deliberately out of v1 scope

- **Locking or arbitration.** D7 forecloses it. If two seats claim overlapping paths, both proceed and
  both can see it.
- **Automatic decision extraction from chat.** A decision record is written deliberately. Inferring
  rulings from prose is how Finding 5 got its ambiguity in the first place.
- **Cross-pod or cross-instance ledgers.** Pod-scoped in v1; federation is ADR-004's problem.
- **Retrofitting history.** No backfill of past rows or past claims. The ledger starts empty.
- **A second notification system, and per-user routing UI.** Foreclosed by the ratified doctrine, not
  by preference — D8 reuses ADR-017's routing layer and D10 forbids a store beside the ledger. A v1
  that ships either has not implemented the doctrine, it has worked around it.

---

## Ratification points (Sam)

1. **D5's container** — board-row update log, or a pod-scoped ledger addressable independent of a row.
   This is the one decision the rest hangs off, and it is genuinely open.
2. **D1's granularity** — is the work area `{branch, baseSha, paths[]}`, or is `{branch, baseSha}`
   enough for v1? Paths are where the cost is, and where the AX-audit collisions live.
3. **D6's third arm** — does "seen by N, answered by 0" surface to the human in v1, or does the
   re-offer alone close #1394?
4. **D4's vocabulary** — three dispositions (`answered` / `passed` / `expired`), or more? Adding one
   later is cheap; changing the meaning of one is not.
5. **Whether D6 belongs here at all.** It is an ADR-018 decision. This ADR proposes to *build* it and
   records why it was never built; the alternative is an ADR-018 amendment and a build task, leaving
   ADR-028 to D1–D5 and D7. Sam asked for them ruled together, so they are drafted together — but the
   home of the rule is a real question and the answer is not obviously this file.

---

## Evidence I could not verify

Sam's kickoff cites a private GTM evidence pack (a wedge memo §3–4 and a competitive dive) with two
claims: that one competitor has scope-memory but no claim primitive, and that another claims the
primitive in a README only. **Those files are operator-held and are not readable from this seat** — I
searched the local filesystem for both by name and found neither, and this repo carries nothing from
them. They are recorded here as **reported, not verified**, and the competitive comparison section is
deliberately left unwritten rather than paraphrased from a summary. Nothing in the audit or in D1–D7
depends on them: every finding above is measured on `origin/main`.

The customer-evidence signal behind #1296 (device-flow CLI auth) is in the same category and is not
this ADR's subject; it is noted only because the kickoff bundles them.
