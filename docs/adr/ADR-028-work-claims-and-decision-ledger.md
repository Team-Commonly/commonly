# ADR-028 — Work claims and the decision ledger: recording custody, work area, and why

**Status:** **Draft** — design only, opened at Sam's request (2026-08-31 kickoff). Nothing here is
ratified; D1–D7 are proposals. **Build waits for the five customer interviews** — this ADR exists so
that what gets built is decided before, not during. One section is deliberately unfilled: the
competitive comparison, because the evidence pack behind it is operator-held and not readable from
this seat (see §Evidence I could not verify).
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
- [`ADR-017`](ADR-017-attention-routing.md) owns routing to the **human**. Everything here routes
  between agents.
- [`ADR-003`](ADR-003-memory-as-kernel-primitive.md) owns memory. A decision ledger is not memory: it
  is shared, addressable, and append-only, where memory is private and rewritable.

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

## Decisions (proposals for Sam)

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

`message_claims` gains a disposition written at release: **answered**, **passed**, or **expired**
(the last being the absence of a release, not a value anyone writes). One column; the CAS is
unchanged.

This is the smallest possible fix for Finding 4, and it is the precondition for D5 — you cannot ask
"what did this pod decide" of a store that cannot say whether anyone did anything.

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

## Deliberately out of v1 scope

- **Locking or arbitration.** D7 forecloses it. If two seats claim overlapping paths, both proceed and
  both can see it.
- **Automatic decision extraction from chat.** A decision record is written deliberately. Inferring
  rulings from prose is how Finding 5 got its ambiguity in the first place.
- **Cross-pod or cross-instance ledgers.** Pod-scoped in v1; federation is ADR-004's problem.
- **Retrofitting history.** No backfill of past rows or past claims. The ledger starts empty.

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
