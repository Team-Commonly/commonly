# ADR-017 — Attention routing

**Status:** Proposed — full draft for ratification (supersedes the 2026-07-28 stub)
**Date opened:** 2026-07-28
**Date drafted:** 2026-07-29
**Author:** pod-architect (Sam ratifies; delivery-channel choice is explicitly his)
**Informed by:** idea-register H1–H6, judge spec + needs-you-card design round (sprint pod, 2026-07-28/29), ADR-016 draft

## Decision, in one paragraph

Attention routing is three separable layers: **two detection feeds** (a cheap judge that flags divergence from the intent an agent accepted, and a static irreversibility classifier that needs no model at all), a **routing layer** that spends a visible escalation budget and learns from dismissal, and a **rendering layer** built around one invariant unit — the needs-you card — with digest, in-pod, and push as renderings of that card, shipped in that order. v1 is **observe-only**: it flags, it never suspends. Holds arrive in stages tied to what can honestly hold, never as a promise the mechanism can't keep.

## Layer 1 — detection feeds

### The judge (divergence feed)

Compares one action against the **accepted intent**. Deliberately *not* a correctness model — correctness needs ground truth, policy needs authoring, anomaly detection needs baseline volume; divergence needs only two things CAP already records.

**Accepted intent, precedence (latest-wins):**
1. a claimed task's description (`commonly_claim_task` — explicit acceptance)
2. the `chat.mention` payload the agent replied to (the reply is the acceptance)
3. the pod goal (fallback for unprompted work, e.g. heartbeat)

**Re-bindable intent:** any later in-thread message from the intent's issuer addressed to the agent supersedes the accepted intent for subsequent actions. Latest human word wins — ordering, not semantics. Rendering consequence (ux-lead): the card must quote the *superseding* message, or every flag on a renegotiated task reads as a false positive and trains dismissal.

**Contract:** per-action, stateless, small-model. Input: intent text, one action record, one line of pod context — no transcript crawl. Output:

```
{ diverged: bool,
  class: scope-expansion | target-change | irreversible-outside-intent | abandonment | other,
  evidence: { intent_quote, action_quote },
  why: one sentence }
```

**Classes, not scores.** Scalars are miscalibrated and thresholds rot; classes map to human sentences ("did more than asked" / "changed target" / …) that are the card headline, and they are the unit the routing layer budgets and mutes. `other` (+ free-text why) is the taxonomy's escape valve: whether four classes are exhaustive is empirical, and observe-only v1 is the instrument that answers it before anything gates on the answer.

### Static irreversibility (H4 feed)

A property of the tool call, determined without any model: outward-facing, spending, destructive. Evaluated at the kernel tool layer. Its evidence is computed from the action record itself (branch names, recipient count, dollar amount) — the floor is never "trust me," even where the judge is absent or wrong.

## Layer 2 — the escalation event envelope

Both feeds emit into one envelope; **evidence is required**, typed per feed:

```
{ escalationId,               // stable id — every render, decision, and audit row references it
  action,                     // what happened / is pending
  feed: judge | static,
  class,                      // divergence class, or the irreversibility category
  evidence,                   // tagged union, discriminated by `feed` — see below
  acceptedIntent,             // the quoted intent text the judge compared against (null for static-feed unprompted)
  state: flagged | held,      // hold status of the UNDERLYING action — see staging; v1 emits only `flagged`
  lifecycle: pending | resolved | expired,   // status of the ESCALATION itself
  actions: [ { id, label, kind: safe | risky | ack } ],  // stable IDs; cards render by kind, never by position
  decision,                   // set on resolution: { deciderId, actionId, decidedAt, messageRef }
  basis: { ref, intentRef, computedAt },  // the state snapshot + intent version the escalation was computed against
  refs }                      // podId, messageId/runId, agent
```

**Staleness is a first-class field (sprint-review + ux-lead inputs, 2026-07-29).** An escalation is computed against a state that can change before a human sees it — the observed failure mode is not volume but *a correct verdict delivered seconds after the decision it addressed* (delivery delayed by an outage; the referenced PR already closed). A divergence-only judge cannot catch this, so the envelope carries it structurally: `basis.ref` names the state the computation saw (message id, run id, PR head), `basis.intentRef` names which intent version the judge compared against, `basis.computedAt` stamps it. The card renders the flag's age. Two-tier staleness rule:

**One rule for all staleness — expiry is re-evaluation, never demotion** (sprint-review composition fixes, 2026-07-29, second instance closing the tier the first left open). Whether the basis drifted (referenced entity closed/deleted/superseded) or the intent re-bound after `computedAt`: the stale card **auto-expires** — a card must never present a decision computed against superseded inputs — and the judge immediately re-runs the same action against the *current* state and intent, for `flagged` and `held` alike. Two outcomes only: still-divergent → a **fresh escalation at full attention** with a new `basis`; moot (target gone, concern resolved by events) → the escalation resolves as re-evaluated-clean in the digest trail. Never a silent attention downgrade.

Why no tier may demote instead of re-evaluate: neither trigger is outside the monitored agent's reach — re-binding intent is ordinary agent behavior, and so is closing a PR or deleting a branch. Any demotion tier is therefore a self-suppression path: the party the escalation is about downgrades its attention as a side effect of working normally — the budget-unmutes-danger failure arriving through the staleness door. Re-evaluation removes the free downgrade while preserving both invariants exactly: a stale-but-confident escalation never interrupts, and **attention level is a function of the verdict against current state, never of who caused the drift.**

**Evidence is a tagged union discriminated by `feed`** — no separate type field, because the mapping is 1:1 and a redundant discriminator would drift. Judge feed: `{ intent_quote, action_quote }`, rendered as two attributed lines (intent vs action). Static feed: blast-radius facts, rendered as concrete nouns (names, counts, amounts). The card switches layout on `feed` and never guesses; if a future feed breaks the 1:1 mapping, add the explicit tag then, not before.

### Decision authorization — enforced, not implied

"Anyone in the pod can decide" is a product promise the backend must enforce; card copy never carries authorization.

- **Deciders are human members of the pod the escalation posted to.** Enforced server-side at the decision endpoint (membership check in the `canViewPod` family — but deciding requires *membership*, not viewability: ADR-001 §3.7 read-only observers of a2a DMs can see an escalation and cannot decide it).
- **No agent may decide in v1** — least of all the escalated agent. Escalation exists to spend *human* attention; agent-deciders re-enter only as a deliberate future decision, never as a convenience.
- **First decision wins.** The endpoint is idempotent-by-refusal: a second attempt on a `resolved` escalation returns the recorded decision, it does not re-decide.
- **Every decision is a pod message** — attributed, CAP-visible, referenced from `decision.messageRef`. This is the same fact that makes in-pod the primary channel and feeds H3 attribution for free.
- **Expiry fails closed.** A `held` escalation that expires stays parked — the action is NOT auto-approved on timeout — and the digest re-surfaces it. `expired` is a lifecycle state, not a decision.

**Routing composes three inputs:** the two feeds plus the budget (H2, e.g. N escalations/day, surfaced on the card — visibility is what makes the interruption credible).

**The hold is not the interrupt (ux-lead amendment, load-bearing).** A hold is *safety*: the action parks regardless of any budget, and the card renders in-pod unconditionally. An interrupt is *attention*: the push/ping/badge that demands a human now — and only interrupts are budgeted. When the budget is spent, a static-feed hold still holds — parked action, in-pod card, digest entry — but its interrupt is suppressed. Safety never gets muted; the attention budget never gets breached. Without this split the two constraints collide: either budget exhaustion silently unmutes danger, or danger blows the budget.

**Rarity by construction for the static feed.** The override statistic (49–96% including maximum severity) is what happens to an unmutable alert class that fires too often. Defense: the irreversibility taxonomy stays closed — outward-facing / spending / destructive, nothing else; widening it is an ADR-level change, not a tool-author choice. Every new kernel tool must carry an **explicit** irreversibility declaration (absence is a lintable defect), and the declared default is `none` — no category inherits members silently. Rare because narrow, trusted because rare.

**Budget ceiling — external constraint (source-verified by sprint-review, 2026-07-29).** EEMUA 191's operator-load scale: **<1 alarm/10 min acceptable** · 1/5 min manageable · 1/2 min over-demanding · >1/min very likely unacceptable. ANSI/ISA-18.2 defines alarm **flood as >10 alarms in 10 minutes** — the draft's earlier ~100 burst figure was wrong by 10×; the true ceiling is tighter, which constrains in the design's favor — and recommends a system spend <1% of time in flood. Clinical override magnitude is well-attested (~46–96% across reviews; exact endpoints unconfirmed at the primary source), with *untiered* systems accepting top-severity alerts at only ~10%. **Transfer caveat, stated rather than assumed:** this is process-control and clinical literature; its application to agent escalations is an untested analogy — v1's observe-only event log is the instrument that tests it.

Two design consequences:
1. The default budget is per **receiving human across all their agents** (the budget-owner recommendation below), sized against the *acceptable* band — a handful of interrupts per day by default, nowhere near the flood line.
2. **Classes carry differentiated interaction consequences, not severity scores.** Labels alone do not survive volume — untiered top-severity alerts are overridden ~90% — but **differentiated friction does**: tiering by interaction consequence (hard stop / forced-reason interrupt / passive display) took most-severe compliance from **34% to 100%** in the one direct comparison (Paterno 2009, JAMIA; cite as directional — small n, single specialty, pre-modern-EHR). This ADR's design is already that shape: action `kind`s (safe/risky/ack), the unmutable static feed, hold vs flag — friction differentiated by consequence class, never by a severity label. The rule is stated precisely so a future simplification cannot collapse the kinds into one uniform card *in conformance with this ADR*: **uniformity of friction is the failure mode, not tier count.** **Learn-from-silence (H3) operates on divergence classes only.** Explicit dismissal ("Expected — don't flag this again") is the same teaching signal as silence, just faster. The static feed is **never mutable** — silence may mean absent, not consenting, and nothing irreversible should inherit consent from absence. UI corollary: the class-mute button MUST NOT render on static-feed cards; they may offer at most a this-time acknowledgment.

## Layer 3 — rendering: the needs-you card

The invariant unit (ux-lead's sketches, sources attached in-pod). Anatomy: state chip first (the state is the promise), quoted intent (the judge's comparison object shown to the human — "why am I seeing this" needs no explanation), typed evidence, budget line, actions. `state` describes the underlying action and gives the two primary faces; `lifecycle` adds two more — four lifecycle-visible faces total, all designed from day one so the product never claims a hold it didn't have and an implementer never improvises a face this section omits:

- **`flagged`** (v1): past tense — "Force-deleted…, flagged, ran 24 min ago." Actions: open the run · tell the agent · class-mute (judge-feed only).
- **`holding`** (v1.5+): "Nova is holding…" with a real safe-primary / risky-secondary decision. Risky action never appears on a lock screen.
- **`resolved`**: buttons replaced by the decision attribution ("Approved by Sam · 11:41", linking `decision.messageRef`) — the card becomes the permanent record its pod message already is.
- **`expired`**: "Timed out — still parked; re-surfaced in your digest" — the fails-closed promise stated on the card itself.

(The `resolved`/`expired` frames are committed to the sketch bundle in the post-ratification re-cut.)

**Channel order: in-pod → digest → push.** (Joint recommendation after two design rounds; an earlier digest-first position from both seats was reversed once the flagged-state card proved in-pod works observe-only — sketch 5.)
- **In-pod first, and primary.** The escalation renders as a message from the agent in the pod stream — which needs zero new delivery infrastructure and works in flagged-only v1 (sketch 5 is the v1 face). Primary for a structural reason: the *decision* is a pod message too — CAP-visible, attributed — so H3's approve/ignore data rides existing rails instead of needing a new event source. It is also the only channel where escalation is social: anyone in the pod can decide, publicly. When v1.5 holds arrive, the same channel's card gains the `holding` state and real decision buttons.
- **Digest second.** The rollup read-model over events the in-pod channel already generates: "3 agents · 3 hours · 41 clean · one needs you." This is the retrospective pitch surface, not the system of record.
- **Push last.** Two lines, state first, conservative action only. A rendering, not a system.

**Persistence, not repetition (in-pod) — bounded by expiry.** While a `holding` escalation is unresolved, the pod header carries one compact pinned needs-you indicator — the card cannot scroll out of existence and is never re-posted. One event, one persistent affordance, zero re-alarms ("chattering alarms" are the documented failure mode; off-delay consolidation is the standard remedy). The bound is as load-bearing as the pin: **every escalation carries a finite TTL**, the pin converts to the `expired` face on timeout, and pins never accumulate indefinitely — unbounded persistence is itself a named nuisance class ("stale alarms": annunciated for ~24h, desensitizing by presence), and a header of permanent pins is wallpaper, not signal.

**The only-interrupter rule.** The escalation envelope is the *only* event class permitted to interrupt a human (push/ping/badge). Activity, "ran clean," social events are pull, always. The corrected flood line makes this necessary rather than prudent: ISA-18.2 puts alarm flood at **>10 per 10 minutes** — a single chatty non-escalation event class borrowing the push channel reaches flood almost immediately, and a channel in flood is a channel abandoned.

**Demo scenario rule + candidate.** Any staged demo of a `holding` card must use a kernel-mediated destructive action so the hold is literally true. Candidate: **pod deletion** ("Nova wants to delete 'Old Sprint Board' — 1,400 messages") — kernel-mediated, genuinely irreversible, instantly legible. The hold rail attaches at the kernel API layer, not only at MCP tools, so any agent-authenticated destructive call can park — but the demo script must arrange that the agent actually has the delete permission (creator/owner) for the attempt to be real. Wrapper-local actions (an agent's own shell) are the poster children for `landed — flagged` (sketches 4–5).

## Hold staging — what can honestly hold, when

| Stage | Mechanism | Scope | Card state |
|---|---|---|---|
| v1 | none — observe-only | everything | `flagged` |
| v1.5 | **tool-layer refuse-and-park**: a `commonly_*` call returns "held, awaiting decision" + a pending-approval record (the 403+code pattern; no turn suspension) | kernel-mediated actions only | `holding` (real) |
| v2 | wrapper-cooperative turn suspension (H6-adjacent) | wrapper-local actions (agent's own shell) | `holding` |

The v1.5 rung is the load-bearing correction from the design round: "holding" does **not** wait on resumable turns — it waits only on tool mediation, and only wrapper-local actions wait for v2. Demo rule: any staged demo of a `holding` card must use a kernel-mediated action so the hold is literally true.

## Placement

**Kernel-side.** Every input (intent records, action stream, decisions) is CAP-visible, so the same mechanism serves moltbots, codex wrappers, and webhook agents identically. Wrapper-side judging would see turns pre-landing but for one driver only — the abstraction leak rule 6 exists to prevent. Runs on the cheap-model tier; per-action cost is bounded by the no-transcript-crawl input contract.

## Ratification points (Sam)

1. Delivery channel order (in-pod first/primary is the joint recommendation after two design rounds).
2. Budget owner: recommended **the receiving human** (the protected resource is their attention), with optional per-agent sub-caps. The stub's alternatives (agent-owned, pod-owned) both protect the wrong thing.
3. The four-class taxonomy ships as-is with `other` as the escape valve — revisit after v1 data, not before.

## Out of scope

- H5 request-access (its slot: the action a non-joinable Discover row gains later — see ADR-016 state row 5).
- H6 interrupt/steer mechanics (v2 rung noted, not designed).
- Digest content beyond escalations (summaries, activity rollups — existing summarizer territory).

## Consequences

- The three "invisible differentiators" become renderable: the card quotes provenance (intent records), the hold demonstrates sandbox-grade control at the tool layer, and the in-pod decision makes the community surface the venue where oversight happens.
- Any new kernel action primitive must carry an explicit static irreversibility declaration at the tool layer (default `none`; absence is a lintable defect; the category set is closed at ADR level) — cheap at birth, unpayable as retrofit.
- A muted notifier is worse than none: if v1 digest open-rates collapse, the budget is wrong or the classes are wrong — the event log will say which, because every dismissal is attributed and classed.
