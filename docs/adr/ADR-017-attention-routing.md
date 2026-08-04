# ADR-017 — Attention routing

**Status:** Proposed — full draft for ratification (supersedes the 2026-07-28 stub)
**Date opened:** 2026-07-28
**Date drafted:** 2026-07-29
**Author:** pod-architect (Sam ratifies; delivery-channel choice is explicitly his)
**Informed by:** idea-register H1–H6, judge spec + needs-you-card design round (sprint pod, 2026-07-28/29), ADR-016 draft

## Decision, in one paragraph

Attention routing is three separable layers: **detection feeds** led by an **authority-boundary** trigger that needs no model at all (an agent has reached something only a human may do), backed by a divergence judge and an irreversibility safety net, a **routing layer** that spends a visible escalation budget and learns from dismissal, and a **rendering layer** built around one invariant unit — the needs-you card — with in-pod, digest, and push as renderings of that card, in that order. v1 is **observe-only**: it flags, it never suspends. Holds arrive in stages tied to what can honestly hold, never as a promise the mechanism can't keep.

## Layer 0 — what the corpus actually showed (labelled 2026-08-01)

This ADR's first draft was designed before any data existed. A labelling pass over this pod's own unattended run — **238 messages, four agents, four days** — corrected it, and the corrections are recorded here because *an ADR that records what didn't work is worth more than one that records only the design*.

**15 of 238 messages (6.3%) warranted interrupting a human.** Sustained rate 0.16/hr; peak 31/10min raw, 5/10min after filtering to escalation-worthy — i.e. the raw stream breaches ISA-18.2's flood line (>10/10min) and the filtered stream does not. That is the whole case for routing in one number pair.

**Regime caveat — every rate above is an *unattended* measurement, and the word appears once, at the top (@sprint-review, 2026-08-04; decomposition and correction @ux-lead, same day).** `:15` says *unattended* and nothing downstream repeats it, so a reader sizing an alarm budget for a pod under active human attention inherits numbers from a regime that isn't theirs. That gap is real and it is the finding. **What it is not is a simple multiplier, and the reason is worth more than the number.**

Measured on this pod's own corpus — 300 messages, `2026-07-29T01:56Z → 2026-08-04T10:08Z`, six contiguous pages with the seams checked for overlap and gaps:

| statistic | value | what selects the window |
|---|---|---|
| burst-weighted | **9.34 / 10min** | episode (gap > 30 min splits) |
| averaged over elapsed | **0.33 / 10min** | clock |
| duty cycle | **3.5%** — 321 active minutes of 9133 | — |

**One dataset, a 28× spread, and the only variable is which window you choose.** This pod does not have a message rate; it has episodes separated by dead days. So `0.41/10min` for the 238-message corpus is an **average**, not a rate, and comparing it against an attended *burst* rate compares two different quantities — which is precisely how three seats produced three attended figures (4.0, 5.28, 9.09) from one tool in one hour, none of them wrong. **Layer 0's own duty cycle has not been measured**, so the honest position is that the multiple between regimes is *unknown*, not that it is ~22×.

**And measured correctly it strengthens this section rather than qualifying it.** ISA-18.2 defines flood in a **10-minute window** exactly because operator load is an episode property that a daily average destroys. Decomposed per-episode, **4 of 10 bursts breach >10/10min on the raw stream, peaking at 21.0/10min sustained across 52 minutes.** The paragraph above argues the raw-stream case from a number that *understates* it.

**Two quantities are named here and neither is measured; do not read past them.** (1) The unattended corpus's duty cycle — without it no regime multiple is computable. (2) The **filtered** attended rate: only the raw attended stream has been measured, and the escalation-worthy *share* is what §Routing's budget is actually sized against. Labelling one attended hour against the four classes above would settle it and is roughly an hour of work nobody has done. **The transferable figure from this section is the 6.3% share, not the rates** — a ratio is scale-free and survives either window; a rate does not.

**The observed classes, ranked by frequency:**

| # | class | count | needs a model? |
|---|---|---|---|
| 1 | **blocked on authority only the human has** — ratify, merge, choose, veto, sequence | 8 | **no** |
| 2 | live exposure discovered | 4 | no (static) |
| 3 | a claim the human was relying on turned out false | 2 | partly |
| 4 | agents deadlocked, cannot self-resolve | 1 | partly |

**The finding that changed the design: "escalate on irreversibility" caught zero of fifteen.** Not few — zero. Across four days no agent deleted, spent, or sent anything outward; the one real exposure was pre-existing, not agent-caused. The static feed was the part explicitly designed to work without a model, and against real data it never fired. Meanwhile the dominant class is not misbehaviour at all: it is **an agent correctly finishing its work and hitting a wall only a human can pass.**

**So the primary trigger is structural, not behavioural.** Not *"is this agent misbehaving?"* but *"has this agent reached a boundary it cannot cross?"* — and the system already knows the answer, because the boundary **is the permission set**. No judge, no scoring, no corpus needed for the dominant 8-of-15 case. This inverts the draft's ordering: the model-free trigger is the frequent one, and the model-dependent one is the tail.

**Standing caveat, in the labeller's own terms — the zero is strong evidence for one claim and weak for another.** This corpus is four agents doing review-and-docs work **with no delete/spend/send permissions in play**. So it is strong evidence that irreversibility is the wrong *primary* trigger, and weak evidence about how often that feed fires in a pod where agents actually hold destructive capability. Keeping it as a safety net is right for exactly that reason: the zero measures this permission profile, not the mechanism's worth. Also n=15, one pod, four days, a single human decision-maker — the class ranking is evidence, not a law. v1's log re-measures it continuously, and class 1's dominance should be expected to shrink as agents gain authority.

## The channel is bidirectional — and the reverse direction has no trigger today

Everything above routes **agent → human**: which of an agent's actions deserves interrupting a person. The inverse direction is missing, and it cost real work on 2026-08-01 before anyone noticed it existed.

**The incident.** The private-pod disclosure was fixed, merged (#793), deployed, and verified closed. The pod was not told. Four agents kept planning, specifying and sequencing around an exposure that had been shut for an hour, until one happened to re-measure it for an unrelated reason. Nothing escalated, because nothing went wrong: no divergence, no irreversible action, no authority boundary. **The world moved and the agents' snapshot didn't.**

Two properties that make this a distinct primitive rather than a missing notification:

1. **It is an invalidation, not an escalation.** The trigger is not *"an agent needs authority"* but *"a fact an agent is relying on has changed."* Note that this is the same shape as observed class 3 — *a claim the human was relying on turned out false* — pointed the other way. That symmetry is the argument for **one mechanism serving both directions**, not two features: in both cases something a party built reasoning on stopped being true, and the party doesn't know.
2. **The cost is silent and asymmetric.** A missed escalation stalls one agent, visibly, and someone eventually notices. A missed invalidation leaves *every* agent confidently producing correct-looking work over a dead premise, with nothing appearing wrong at all. This is the failure mode this sprint rediscovered in five different costumes — stale review verdicts, superseded ADR versions, a fixed-then-asserted route, phantom cross-layer contracts, an unbounded log window. Correct output over a broken premise is the house failure, and it is invisible by construction.

**The principle for v1 (deliberately not a mechanism):** the attention channel is bidirectional. A merge or deploy touching a surface an agent has reasoned about should land in that agent's pod as a *fact*, not as a notification anyone has to compose. Cheap version first — the same event log that feeds the digest already knows what shipped; the missing piece is that nothing points it back at the agents. **Do not build a subscription system for this.** The measured need is one line per merge **or deploy**, and n=3 incidents are not a mandate for a dependency graph. *(Sizing sentence corrected 2026-08-04 on @sprint-review's review: it read "one line per merge, and n=2" while the third instance three paragraphs down is a **deploy with no merge attached** — so the sentence narrowed the correct principle stated one line above it and then certified the narrowing with a stale count. A deploy line is still one line and still needs no subscription model, so the fix strengthens the anti-graph argument rather than qualifying it.)*

**n=1 became n=2 before this draft was reviewed, and the second instance is this file's own merge** (found by @sprint-review, 2026-08-04). #797 merged at `07:33:37Z`, closing the exact divergence ADR-016's §Enforcement-gaps documented as open; #792 merged both ADRs at `07:33:49Z`. **Twelve seconds** — two PRs reviewed in parallel by seats that could not see each other, so the sibling document shipped stale on arrival. That is *superseded ADR versions*, the second costume in the list above, produced by the merge that introduced the list.

It is worth being precise about which way this cuts. **n=2 raises confidence that the trigger is real and *lowers* the case for a dependency graph, because one line per merge would have caught both.** No subscription, no graph, no per-agent interest model: had `#797 merged — agent discovery / podListing` landed in this pod as a fact, the reviewer of #792 had twelve seconds' warning and the reader afterwards had none. The cheap mechanism is not a compromise against the expensive one here; it is strictly the one the evidence asks for.

One qualification the incident also supplies: the stale row was **accidentally right about production** for as long as #797 stayed merged-and-undeployed. A reader spot-checking against the live instance got confirmation of a section `main` already contradicted. So the fact worth routing is not "merged" alone — merged and deployed are different events and an agent verifying against a running system needs both.

**n=3, and it is the strongest of the three, because this time the fact was the one every agent in the pod was explicitly waiting for (@pod-architect, 2026-08-04, self-reported).** `Deploy Dev` was dispatched `09:52:40Z`; the `backend` pod restarted on the new tag at `09:59:09Z`. Nothing said so. What the pod did in that window: `09:53:22Z`, a seat closes with *"@Sam — rotate the PAT, then … → dispatch"* — 42 seconds after the dispatch it is asking for. `09:59:39Z`, I close with the same ask, thirty seconds after the rollout completed. `10:01:34Z`, I assert *"Live is still `eb05c683`"* as a measured fact, 2m25s after it stopped being one — while the instrument I was using had already changed behaviour under my hands.

The first two instances have the form *a fact changed and nobody was told*. This one is *the fact four agents had spent two hours requesting changed, and nobody was told*: maximal priming, same outcome, which is what rules out attention as the missing ingredient. It also settles the cheapest objection to the mechanism — one line per merge would **not** have caught this, because the event is a deploy and no merge accompanied it. The trigger is both events, exactly as the paragraph above concludes, and this is the instance that pays for the second half.

**The unannounced window was 5m58s, and the way it closed is this incident's original mechanism repeating verbatim.** @sprint-review found the roll at `10:05:07Z` — not because anything announced it, but while re-measuring the message pager to check a peer's claim about a different question, and running `git merge-base` on the deployed tag as a side-effect. The 2026-08-01 write-up of the first instance says the pod stayed wrong *"until one re-measured it for an unrelated reason."* Same route, three days later, four agents watching for this exact event. **What the pod has instead of a signal is the chance that someone's unrelated query happens to graze the changed fact** — which is why the measured window is a property of query traffic, not of diligence, and why it should not be read as "six minutes is fine." Under the same conditions with no incidental probe it is unbounded, which is the 2026-08-01 case at an hour and counting.

Design note connecting it to the rest of this ADR: `basis` (§envelope) already records *what state an escalation was computed against*. Invalidation is the same field read from the other end — the system knowing a basis went stale is precisely the signal an agent needs. One field, two directions.

## Layer 1 — detection feeds

### Authority boundary (primary trigger — no model)

Fires when an agent's next step requires a permission it does not hold, or when it has produced a terminal artifact whose only remaining transition belongs to a human. Both are readable from state the kernel already has — the permission set, the artifact's status — so this feed is a **query, not an inference**: cheapest to run, impossible to hallucinate, and it covers the largest observed class.

Observed class-1 instances: a PR verified and green with merge reserved to the human; an ADR marked Proposed awaiting ratification; a spec whose next action requires an operator-only credential (the Cloudflare retention check). (The deadlock case — two agents holding opposed rulings where neither seat owns the call — is class 4, not class 1; it reaches the same human by a different route.) In each, the agent did nothing wrong — it *finished*.

**Evidence for this feed is the boundary itself**: which permission, which artifact, what the human's available transitions are. That makes the card actionable by construction — it names the decision rather than describing the situation.

Design consequence worth stating: this trigger's frequency is a **measure of how much authority agents lack**. If class 1 stays at 8-in-15 as the system matures, that is a finding about delegation, not about attention. The right long-run response to a chronically firing authority boundary is usually to move the boundary, not to route more notifications across it.

### The judge (divergence feed — secondary)

Compares one action against the **accepted intent**. Deliberately *not* a correctness model — correctness needs ground truth, policy needs authoring, anomaly detection needs baseline volume; divergence needs only two things CAP already records.

**Accepted intent, precedence (latest-wins):**
1. a claimed task's description (`commonly_claim_task` — explicit acceptance)
2. the `chat.mention` payload the agent replied to (the reply is the acceptance)
3. the pod goal (fallback for unprompted work, e.g. heartbeat)

**Re-bindable intent:** any later in-thread message from the intent's issuer addressed to the agent supersedes the accepted intent for subsequent actions. Latest word wins — **ordering, not identity**: the superseding message may come from a human or an agent, because intent issuers can be either (`Task` carries no issuer provenance, and `Task.source` is caller-supplied). Never write a human-only re-bind gate. **Two reasons, and only one of them is permanent — stated separately because they expire differently (@sprint-review, 2026-08-04):** the load-bearing one is that intent issuers can legitimately be either, so gating on issuer *type* would drop valid re-binds no matter how well it were implemented. The contingent one is that there is currently no field to build such a gate on. **If `Task.createdBy` lands, the second sentence becomes false and the prescription still stands** — a reader who finds the field must not read its arrival as authorization to build the gate. See the staleness rule, which is what makes this safe. Rendering consequence (ux-lead): the card must quote the *superseding* message, or every flag on a renegotiated task reads as a false positive and trains dismissal.

**Contract:** per-action, stateless, small-model. Input: intent text, one action record, one line of pod context — no transcript crawl. Output:

```
{ diverged: bool,
  divergenceClass: scope-expansion | target-change | abandonment | other,
  evidence: { intent_quote, action_quote },
  why: one sentence }
```

**Classes, not scores.** Scalars are miscalibrated and thresholds rot; classes map to human sentences ("did more than asked" / "changed target" / …) that are the card headline, and they are the unit the routing layer budgets and mutes. `other` (+ free-text why) is the taxonomy's escape valve: whether the divergence classes are exhaustive is empirical, and observe-only v1 is the instrument that answers it before anything gates on the answer.

### Static irreversibility (H4 feed — safety net, kept despite firing zero times)

A property of the tool call, determined without any model: outward-facing, spending, destructive. Evaluated at the kernel tool layer. Its evidence is computed from the action record itself (branch names, recipient count, dollar amount) — the floor is never "trust me," even where the judge is absent or wrong.

**It caught 0 of 15 in the observed corpus, and it stays anyway.** Not as the primary trigger it was drafted to be, but as a safety net, on an explicit asymmetry: its false-negative cost is unbounded (one unreviewed destructive action) while its false-positive cost is bounded by the budget and by rarity-by-construction. A trigger that never fires costs nothing; the one time it fires may be the only time it matters. What the zero *does* forbid is treating it as the design's centre of gravity — that was the drafting error, and it came from reasoning about agents from first principles instead of watching them work.

## Layer 2 — the escalation event envelope

All three feeds emit into one envelope; **evidence is required**, typed per feed:

```
{ escalationId,               // stable id — every render, decision, and audit row references it
  action,                     // what happened / is pending
  feed: authority | judge | static,
  escalationClass,            // OBSERVED taxonomy: authority-boundary | exposure | false-claim | deadlock
                              // (distinct from the judge's divergenceClass — different layers, never merged:
                              //  this says why a human was interrupted, that says how an action departed from intent.
                              //  Named `escalationClass`, not `class`, on @sprint-review's review: two same-named
                              //  sibling fields kept apart by a comment is the shape we spent 2026-08-04 removing
                              //  everywhere else. Put the separation in the type, where a simplifier cannot read past it.)
  evidence,                   // tagged union, discriminated by `feed` — see below
  acceptedIntent,             // the quoted intent text the judge compared against (null for static-feed unprompted)
  state: flagged | held,      // hold status of the UNDERLYING action — see staging; v1 emits only `flagged`
  lifecycle: pending | resolved | expired | superseded | moot,  // status of the ESCALATION itself
                              // `resolved` is the ONLY value carrying a `decision`, and the only one a human writes.
                              // `expired` = TTL timeout: still parked, human should look (fails closed).
                              // `superseded` = staleness re-evaluation produced a fresh escalation; a successor exists.
                              // `moot` = staleness re-evaluation found the concern gone; nothing for anyone to do.
                              // The last three are machine transitions and carry `decision: null` (see below).
  actions: [ { id, label, kind: safe | risky | ack } ],  // stable IDs; cards render by kind, never by position
  decision,                   // set on resolution: { deciderId, actionId, decidedAt, messageRef }
  basis: { ref, intentRef, computedAt },  // the state snapshot + intent version the escalation was computed against
  refs }                      // podId, messageId/runId, agent
```

**Staleness is a first-class field (sprint-review + ux-lead inputs, 2026-07-29).** An escalation is computed against a state that can change before a human sees it — the observed failure mode is not volume but *a correct verdict delivered seconds after the decision it addressed* (delivery delayed by an outage; the referenced PR already closed). A divergence-only judge cannot catch this, so the envelope carries it structurally: `basis.ref` names the state the computation saw (message id, run id, PR head), `basis.intentRef` names which intent version the judge compared against, `basis.computedAt` stamps it. The card renders the flag's age.

**One rule for all staleness — retirement is re-evaluation, never demotion** (sprint-review composition fixes, 2026-07-29, second instance closing the tier the first left open; "expiry" throughout this rule renamed to "retirement" on 2026-08-04, since `expired` now means TTL and only TTL). Whether the basis drifted (referenced entity closed/deleted/superseded) or the intent re-bound after `computedAt`: the stale card is **auto-retired** — a card must never present a decision computed against superseded inputs — and the judge immediately re-runs the same action against the *current* state and intent, for `flagged` and `held` alike. Two outcomes only: still-divergent → the stale card goes **`superseded`** and a **fresh escalation at full attention** is emitted with a new `basis`; moot (target gone, concern resolved by events) → the stale card goes **`moot`** in the digest trail. Never a silent attention downgrade.

**Why these are two lifecycle values and not `expired` or `resolved` (@sprint-review's J1/J2, adopted 2026-08-04).** An earlier revision routed both through `expired`, which already means *TTL timeout — still parked, look at it*. The staleness path means the opposite: a successor exists, or the concern is gone, and the human should do **nothing**. One value carrying both instructions makes the stale card inherit the TTL copy and tells a human an item awaits them for work that was already re-escalated at full attention — double-counting one action in the digest, which is the chattering-alarm failure the persistence rule spends its length preventing. The same revision said the moot case *"resolves as re-evaluated-clean"*, which collides with `resolved`'s contract three rules down: `decision` is `{deciderId, actionId, decidedAt, messageRef}`, every decision is an attributed pod message, and **no agent may decide in v1**. A machine re-evaluation satisfies none of those. So: **`resolved` is the only lifecycle value that carries a `decision`, and the only one a human writes.** Mootness is not a decision, and now it does not have to pretend to be one. *(Both defects entered with the staleness rule itself — a machine-driven transition added to an envelope designed end-to-end for human-driven ones, self-reported by its author.)*

Why no tier may demote instead of re-evaluate: neither trigger is outside the monitored agent's reach — re-binding intent is ordinary agent behavior, and so is closing a PR or deleting a branch. Any demotion tier is therefore a self-suppression path: the party the escalation is about downgrades its attention as a side effect of working normally — the budget-unmutes-danger failure arriving through the staleness door. Re-evaluation removes the free downgrade while preserving both invariants exactly: a stale-but-confident escalation never interrupts, and **attention level is a function of the verdict against current state, never of who caused the drift.**

**Evidence is a tagged union discriminated by `feed`** — no separate type field, because the mapping is 1:1 and a redundant discriminator would drift. **Authority feed: `{ boundary, artifact, availableTransitions }`** — which permission is missing, which artifact is terminal, what the human can do about it — rendered as a named decision with its options, which is why class-1 cards are actionable rather than merely informative. Judge feed: `{ intent_quote, action_quote }`, rendered as two attributed lines (intent vs action). Static feed: blast-radius facts, rendered as concrete nouns (names, counts, amounts). The card switches layout on `feed` and never guesses; if a future feed breaks the 1:1 mapping, add the explicit tag then, not before.

### Decision authorization — enforced, not implied

"Anyone in the pod can decide" is a product promise the backend must enforce; card copy never carries authorization.

- **Deciders are human members of the pod the escalation posted to.** Enforced server-side at the decision endpoint (membership check in the `canViewPod` family — but deciding requires *membership*, not viewability: ADR-001 §3.7 read-only observers of a2a DMs can see an escalation and cannot decide it).
- **No agent may decide in v1** — least of all the escalated agent. Escalation exists to spend *human* attention; agent-deciders re-enter only as a deliberate future decision, never as a convenience.
- **First decision wins.** The endpoint is idempotent-by-refusal: a second attempt on a `resolved` escalation returns the recorded decision, it does not re-decide.
- **Every decision is a pod message** — attributed, CAP-visible, referenced from `decision.messageRef`. This is the same fact that makes in-pod the primary channel and feeds H3 attribution for free.
- **Expiry fails closed.** A `held` escalation that expires stays parked — the action is NOT auto-approved on timeout — and the digest re-surfaces it. `expired` is a lifecycle state, not a decision.

**Routing composes four inputs:** the three feeds plus the budget (H2, e.g. N escalations/day, surfaced on the card — visibility is what makes the interruption credible).

**The hold is not the interrupt (ux-lead amendment, load-bearing).** A hold is *safety*: the action parks regardless of any budget, and the card renders in-pod unconditionally. An interrupt is *attention*: the push/ping/badge that demands a human now — and only interrupts are budgeted. When the budget is spent, a static-feed hold still holds — parked action, in-pod card, digest entry — but its interrupt is suppressed. Safety never gets muted; the attention budget never gets breached. Without this split the two constraints collide: either budget exhaustion silently unmutes danger, or danger blows the budget.

**Static-feed interrupts are exempt from the budget entirely (@sprint-review's J3, adopted 2026-08-04) — the rule above was still one step short.** Compose "its interrupt is suppressed" with rarity-by-construction and the suppression can only ever fire on a budget the *judge* feed spent: the static feed is rare by design, so it cannot exhaust its own ceiling. The result is the class this ADR calls unmutable going un-interrupted because of noise from the classes it calls mutable — which is *"budget exhaustion silently unmutes danger"* wearing liveness instead of safety, i.e. the exact failure the split exists to prevent, re-entering through the door the split left open. **The fix is the same argument that justifies keeping the feed at 0-of-15: rarity.** A trigger narrow enough to be trusted is narrow enough to exempt — exempting it cannot flood a channel it structurally cannot fill, and if it ever could, the taxonomy widened and that is an ADR-level change by §Rarity. So: destructive actions interrupt whether or not a human has spent their judge-feed budget today. Safety is never muted, and now that sentence is true of the interrupt as well as the hold.

**Rarity by construction for the static feed.** The override statistic (46–96% across reviews, including maximum severity) is what happens to an unmutable alert class that fires too often. Defense: the irreversibility taxonomy stays closed — outward-facing / spending / destructive, nothing else; widening it is an ADR-level change, not a tool-author choice. Every new kernel tool must carry an **explicit** irreversibility declaration (absence is a lintable defect), and the declared default is `none` — no category inherits members silently. Rare because narrow, trusted because rare.

**Budget ceiling — external constraint (source-verified by sprint-review, 2026-07-29).** EEMUA 191's operator-load scale: **<1 alarm/10 min acceptable** · 1/5 min manageable · 1/2 min over-demanding · >1/min very likely unacceptable. ANSI/ISA-18.2 defines alarm **flood as >10 alarms in 10 minutes** — the draft's earlier ~100 burst figure was wrong by 10×; the true ceiling is tighter, which constrains in the design's favor — and recommends a system spend <1% of time in flood. Clinical override magnitude is well-attested (~46–96% across reviews; exact endpoints unconfirmed at the primary source), with *untiered* systems accepting top-severity alerts at only ~10%. **Transfer caveat, stated rather than assumed:** this is process-control and clinical literature; its application to agent escalations is an untested analogy — v1's observe-only event log is the instrument that tests it.

Two design consequences:
1. The default budget is per **receiving human across all their agents** (the budget-owner recommendation below), sized against the *acceptable* band — a handful of interrupts per day by default, nowhere near the flood line.
2. **Classes carry differentiated interaction consequences, not severity scores.** Labels alone do not survive volume — untiered top-severity alerts are overridden ~90% — but **differentiated friction does**: tiering by interaction consequence (hard stop / forced-reason interrupt / passive display) took most-severe compliance from **34% to 100%** in the one direct comparison (Paterno 2009, JAMIA; cite as directional — small n, single specialty, pre-modern-EHR). This ADR's design is already that shape: action `kind`s (safe/risky/ack), the unmutable static feed, hold vs flag — friction differentiated by consequence class, never by a severity label. The rule is stated precisely so a future simplification cannot collapse the kinds into one uniform card *in conformance with this ADR*: **uniformity of friction is the failure mode, not tier count.** **Learn-from-silence (H3) operates on divergence classes only.** Explicit dismissal ("Expected — don't flag this again") is the same teaching signal as silence, just faster. The static feed is **never mutable** — silence may mean absent, not consenting, and nothing irreversible should inherit consent from absence. UI corollary: the class-mute button MUST NOT render on static-feed cards; they may offer at most a this-time acknowledgment.

## Layer 3 — rendering: the needs-you card

The invariant unit (ux-lead's sketches, sources attached in-pod). Anatomy: state chip first (the state is the promise), quoted intent (the judge's comparison object shown to the human — "why am I seeing this" needs no explanation), typed evidence, budget line, actions. `state` describes the underlying action and gives the two primary faces; `lifecycle` adds four more — **six** faces total, all **specified here** from day one so the product never claims a hold it didn't have and an implementer never improvises a face this section omits. **Specified, not drawn, and the distinction is load-bearing (@ux-lead, 2026-08-04, self-reported against their own section):** the attached sketch bundle carries `flagged` (sketch 5) and no other face — `escalation-4` is the digest view and `escalation-6` the channel decision, neither a card face. The other five exist as the copy and behavior written below, which is enough to implement against and is *not* enough to claim a design artifact for. An earlier revision said "designed from day one" with the artifact status parked in a parenthetical five lines down; an implementer skimming for *which faces do I build* reads the strong claim and stops. Same shape as ADR-016 §Writers — a sentence that is only true if you also read the correction under it. The guarantee that matters survives verbatim: **nothing gets invented at implementation time.**

- **`flagged`** (v1): past tense — "Force-deleted…, flagged, ran 24 min ago." Actions: open the run · tell the agent · class-mute (judge-feed only).
- **`holding`** (v1.5+): "Nova is holding…" with a real safe-primary / risky-secondary decision. Risky action never appears on a lock screen.
- **`resolved`**: buttons replaced by the decision attribution ("Approved by Sam · 11:41", linking `decision.messageRef`) — the card becomes the permanent record its pod message already is.
- **`expired`**: "Timed out — still parked; re-surfaced in your digest" — the fails-closed promise stated on the card itself. **TTL only.** This copy tells a human to look, so nothing that means *don't look* may borrow it.
- **`superseded`**: "Re-checked against current state — see the newer flag" — links the successor escalation. No actions; the successor carries them.
- **`moot`**: "No longer applicable — the concern resolved itself before you saw it." Terminal, no actions, digest-trail only. Never rendered as an interrupt: it is the one face whose whole content is *you did not need to be here*.
  - **`moot` retires the card; it never causes a parked action to execute (@ux-lead, 2026-08-04, reviewing this section).** `expired` is specified to fail closed for `held` actions — parked on timeout, never auto-approved — and `moot` had no such rule while being the *stronger* trigger: it is terminal, so unlike `superseded` there is no successor to carry the hold forward. Left unspecified, a `held` action whose card goes `moot` either sits parked with no card routing it to anyone, or releases because a machine re-evaluation found the concern gone — and a machine releasing a held action is precisely what the `resolved`-only-decides rule forbids. So the hold survives its card: **retiring an escalation is never an approval.** Releasing a `held` action requires `resolved`, which only a human writes. Nothing fires in v1 (observe-only emits `flagged` alone), which is exactly why this was reachable by a reader now and would otherwise have been found by an implementer at v1.5. **The asymmetry is the finding: the weaker trigger got the safety rule and the stronger one didn't.**

(The `holding`/`resolved`/`expired`/`superseded`/`moot` frames are committed to the sketch bundle in the post-ratification re-cut — **five frames, and that re-cut is the only thing this section defers.** The specs above are merged and implementable now; only the drawings wait on ratification. Recorded precisely because the deliverable had been carried as gated design work when the design is written and it is the artifact that is parked.)

**Channel order: in-pod → digest → push.** (Joint recommendation after two design rounds; an earlier digest-first position from both seats was reversed once the flagged-state card proved in-pod works observe-only — sketch 5.)
- **In-pod first, and primary.** The escalation renders as a message from the agent in the pod stream — which needs zero new delivery infrastructure and works in flagged-only v1 (sketch 5 is the v1 face). Primary for a structural reason: the *decision* is a pod message too — CAP-visible, attributed — so H3's approve/ignore data rides existing rails instead of needing a new event source. It is also the only channel where escalation is social: anyone in the pod can decide, publicly. When v1.5 holds arrive, the same channel's card gains the `holding` state and real decision buttons.
- **Digest second.** The rollup read-model over events the in-pod channel already generates: "3 agents · 3 hours · 41 clean · one needs you." This is the retrospective pitch surface, not the system of record.
- **Push last.** Two lines, state first, conservative action only. A rendering, not a system.

**Persistence, not repetition (in-pod) — bounded by expiry.** While a `holding` escalation is unresolved, the pod header carries one compact pinned needs-you indicator — the card cannot scroll out of existence and is never re-posted. One event, one persistent affordance, zero re-alarms ("chattering alarms" are the documented failure mode; off-delay consolidation is the standard remedy). The bound is as load-bearing as the pin: **every escalation carries a finite TTL**, the pin converts to the `expired` face on timeout, and pins never accumulate indefinitely — unbounded persistence is itself a named nuisance class ("stale alarms": annunciated for ~24h, desensitizing by presence), and a header of permanent pins is wallpaper, not signal.

**Every terminal value unpins, stated exhaustively because the two machine ones were silently outside it (@ux-lead, 2026-08-04, reviewing this section).** The sentence above was written when `resolved` and `expired` were the only exits, so *"unresolved"* meant *not yet decided*; adding `superseded` and `moot` widened the set the word quantifies over without anyone re-reading it. The pin clears on **`resolved`**, on **`expired`** (converting to that face), on **`superseded`** — the successor escalation is emitted at full attention and pins in its place, so one action never holds two pins, which is the double-count the J1/J2 rule forbids in the digest and would otherwise have re-entered through the header — and on **`moot`**, immediately, leaving only a digest-trail entry: a `moot` pin is a header slot whose entire content is *you did not need to be here*, which is the stale-alarm class this paragraph spends its length preventing. **Same genus as J1/J2 one layer down** — a new value added to a set that older prose quantified over loosely, so the defect is not in either rule but in the join between them.

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
3. **Two taxonomies, both shipping as-is** — the envelope's observed-class set (authority-boundary · exposure · false-claim · deadlock, from the 2026-08-01 labelling) and the judge's divergence set (scope-expansion · target-change · abandonment · `other`). They sit at different layers and are deliberately not merged; `other` is the escape valve on the judge's set. Revisit after v1 data, not before.

## Out of scope

- H5 request-access (its slot: the action a non-joinable Discover row gains later — see ADR-016 state row 5).
- H6 interrupt/steer mechanics (v2 rung noted, not designed).
- Digest content beyond escalations (summaries, activity rollups — existing summarizer territory).

## Consequences

- The three "invisible differentiators" become renderable: the card quotes provenance (intent records), the hold demonstrates sandbox-grade control at the tool layer, and the in-pod decision makes the community surface the venue where oversight happens.
- Any new kernel action primitive must carry an explicit static irreversibility declaration at the tool layer (default `none`; absence is a lintable defect; the category set is closed at ADR level) — cheap at birth, unpayable as retrofit.
- A muted notifier is worse than none: if v1 digest open-rates collapse, the budget is wrong or the classes are wrong — the event log will say which, because every dismissal is attributed and classed.
