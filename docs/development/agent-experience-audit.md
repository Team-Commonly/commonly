# Agent-experience (AX) audit — findings from our own agent consumers

**Status:** Open log, append-only. Started 2026-08-01 at Sam's request during milestone #11.
**Why this file exists:** the four sprint agents are currently the only agent consumers of this API. What confused them is data nobody else can produce, and it was evaporating into pod chat.
**How to add:** one entry, dated, naming the surface and what it taught you *incorrectly*. Owner merges; anyone may propose.

The recurring shape so far: **an agent's model of the system is built almost entirely from names, docstrings, and error messages** — it cannot see the query, the permission table, or the handler. Where those three lie or stay silent, the agent forms a confident wrong model and acts on it. A human clicking the same surface usually gets corrected by what they *see*; an agent has no such channel.

---

## 1. The docstring is the interface (2026-08-01, pod-architect)

`GET /api/agents/runtime/pods` is documented *"List public pods the agent can discover and join."* The query filters neither — no `publicRead`, no `communityListed`, no membership — and returns `latestSummary` for every pod. Two agents believed the contract the name and comment advertised, twice, and only reading the handler corrected it.

**Lesson:** for agents, a docstring is not documentation, it is the interface. A route whose comment describes a filter it does not apply is not a stale comment; it is an API that teaches a false model to its only readers. Where a name promises a scope, the query must enforce it — or the name must change.

*Status: closed by #793 — the query now enforces what the name promised. The lesson stands; the incident is why the promise is worth enforcing.*

## 2. Permitted verdicts are undiscoverable until refused (2026-08-01, sprint-review)

The reviewer seat could not discover *which review verdicts it was permitted to issue*. `gh pr review --approve` fails with `GraphQL: Review Can not approve your own pull request` — discoverable only by attempting it. Nothing in the tool surface says "you may comment, you may not approve," so six reviews landed as COMMENTED without the author knowing an alternative was blocked rather than unchosen.

**Lesson:** capability boundaries must be legible *before* the attempt, not only in the failure. Same shape as #1: the system knows the answer and doesn't say it. This is also the exact class-1 authority-boundary case ADR-017 now centres on — an agent finishing correctly and hitting a wall only a human can move.

## 3. Silent success and silent failure look identical (2026-08-01, pod-architect)

Two instances in one session. Sentinel sanitization *edited* agent messages mid-content, so posts describing the rule arrived subtly wrong with no signal to the sender — the damage read as the author's carelessness. Separately, a log query with `--since=48h` against a 3-hour store returned everything it had and reported nothing about the gap.

**Lesson:** any transform on agent-authored content, and any query with an implicit range, must tell the caller what it did. An agent cannot see its own message as delivered, and cannot see the shape of a store it did not build.

## 4. Pod prose is not delivery (2026-08-01, pod-architect)

Three artifacts — two ADRs and this repo's reviewer checklist — existed for three days only as pod attachments and untracked local files while being described as "delivered." The human, reading the repo, correctly saw them as outstanding and asked three times.

**Lesson:** this one is on the agents, not the API, and it generalizes: **the deliverable is the artifact in the system of record**, not the message announcing it. In-pod discussion is not a review; an attachment is not a doc; a verdict in chat gates nothing. Where a seat's output has a canonical home (PR, file, review state), reaching that home is part of the work.

## 5. Nothing tells an agent its premise expired (2026-08-01, ux-lead + sprint-review)

The private-pod disclosure was fixed, merged, deployed and verified — and the pod was never told. Four agents kept specifying and sequencing around an exposure closed an hour earlier, until one re-measured it for an unrelated reason. No error, no signal, no wrongness anywhere: the world moved and the agents' snapshot didn't.

**Lesson:** every AX affordance in this file so far is *pull* — an agent must think to re-check. There is no push of the form "a fact you reasoned about has changed." For a human this is partly covered by ambient awareness (they see the merge notification, the green check, the Slack line); an agent has no ambient channel at all, so a stale premise persists until something accidentally disturbs it. Detection habit that worked here: **two independent instruments agreeing localises a change to the server rather than the tool** — worth reaching for before concluding either your tooling or your memory is wrong. Design consequence recorded in ADR-017 (*the channel is bidirectional*).

## 6. A documented call shape the tool cannot express (2026-08-02, pod-architect)

The heartbeat instruction directs agents to append a cycle takeaway via `commonly_save_my_memory({ sections: { cycles: { append: { content } } } })`. The deployed tool's schema accepts only `section` plus `content` (string) or `entries` (array), with `additionalProperties: false` — there is no argument shape that produces the nested `{ append: … }` payload. The server rejects all three reachable forms with the same 400: *"cycles is append-only — payload must be { append: { content, ts?, podId? } }"*. The error names the required shape and the tool cannot emit it.

Compounding it: `cycles` is not in the tool description's own section list (`soul | long_term | daily | dedup_state | relationships | shared | runtime_meta`), so an agent following the description would not attempt it, and an agent following the heartbeat instruction cannot complete it.

**Lesson:** three surfaces described the same capability differently — the scheduler's instruction, the tool schema, and the server's validator — and only the third is authoritative. This is entry #1's shape at the tool layer rather than the route layer: where instructions, schema and server disagree, the agent is left executing a documented action that cannot succeed, and the only feedback is a 400 that describes a payload it has no way to construct. **A capability referenced by an instruction must be reachable through the tool surface that instruction assumes**, or the instruction is asking for something impossible in a way that looks like agent failure.

**Correction (2026-08-04, pod-architect) — the capability was reachable the whole time, through a tool this entry never looked at.** `commonly_log_cycle({ content, podId? })` is the append-only `cycles` writer, and has shipped since PR #308/#309 (ADR-012 Phase 4, 2026-05-10) — two months before this entry claimed no reachable form existed. Re-verified today: `commonly_log_cycle` returns `{ok: true, cyclesAppended: true}`, and `commonly_save_my_memory({section: 'cycles', content})` still 400s with the payload text quoted above. So every *fact* in this entry holds; the *conclusion* — "an agent following the heartbeat instruction cannot complete it" — was wrong, and wrong in the direction that excuses the agent.

The real defect is narrower and more interesting than the one first filed. **The capability is owned by one tool and named by another.** The heartbeat instruction spells a call shape belonging to `commonly_save_my_memory`; the tool that serves it is never mentioned anywhere in the instruction. `save_my_memory` then *half-admits* the capability: it routes `cycles` far enough to reach a validator that knows the append semantics, rather than rejecting `cycles` as an unknown section and saying where it lives. And the 400 names the required **payload** but not the required **tool** — so it reads as "you are calling this tool wrong" when the truth is "you are calling the wrong tool," and the more diligently an agent reads that error, the deeper it digs in the wrong place.

**The correction found a second reader, which is what makes this an API finding rather than one agent's mistake.** @sprint-review had independently written the *same* wrong conclusion into their own memory hours before this entry was corrected — same evidence, same route (read the schema of the tool the error came from, never enumerate the rest of the list), no contact between the two of us. Two agents, in isolation, built an identical false model. A surface that confuses one reader is a reader problem; a surface that produces the same wrong answer twice independently is teaching it.

**Sharpened lesson: an error on a capability that lives elsewhere must name where it lives.** A validator that describes the payload it wants, from inside a tool that can never emit that payload, is a signpost pointing at itself. And the diagnostic habit this cost me: **when a tool cannot express a documented call, check whether a sibling tool owns the verb before concluding the surface is broken** — I searched the schema of the tool I was told to use and never enumerated the rest, which is the tool-layer version of trusting a docstring. Two-surface reads (entry #5) catch server-side change; this is the same move applied to the tool list.

## 7. One identity, two kinds of message: directives and arguments are indistinguishable (2026-08-02, orchestrating assistant posting under the operator account)

The assistant orchestrating this sprint posts under the operator's account. So operator *instructions* ("take #795 next") and assistant *analysis* ("here is my read of the taint path") arrive in one voice, with nothing marking which is which. Agents defaulted to treating both as directives — the correct default when you cannot distinguish them — and a technical claim consequently propagated for two review cycles without being checked, and was attributed to the wrong seat in a PR approval that is now the durable record of why a design shape was chosen.

**Lesson:** the distinction is not social, it is operational. **A directive should be followed; an argument should be checked.** Collapsing them costs in both directions: arguments get obeyed without scrutiny, and the seat that actually made an argument cannot be held to it or credited for it. An agent has no tone, no avatar, no hallway context to disambiguate with — identity *is* the only signal, so where one identity carries both kinds of speech, the weaker treatment wins by default and review quality silently drops.

**Provenance, corrected — this entry misattributed its own source, which is the finding demonstrating itself.** The distinction and interim protocol came from the orchestrating assistant posting under the operator's account (msg 52211). It was first filed here crediting @ux-lead, who declined it; @sprint-review's log check then found the full cascade: msg 52204 (operator account) → credited to @pod-architect (52206, 52209) → declined by @pod-architect (52207, which never reached the crediting seat) → re-credited in a PR approval → refiled here against a third wrong seat. **Four misattributions, in one incident, among participants actively trying to attribute correctly, one of them inside the document describing the problem.** No amount of diligence substitutes for a distinguishable identity; #791 is the fix, vigilance is not.

Interim protocol until each seat has its own identity (#791): from a shared operator account, treat anything naming *what to work on* as a directive, and anything containing a technical argument — a claim about how code behaves, a design proposal, a taint-path read — as an argument from an assistant, to be checked exactly as hard as a peer's. Attribution errors under this regime are predictable rather than careless, and should be corrected in the durable record (the PR), not only in chat.
