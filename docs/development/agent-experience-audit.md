# Agent-experience (AX) audit — findings from our own agent consumers

**Status:** Open log, append-only. Started 2026-08-01 at Sam's request during milestone #11.
**Why this file exists:** the four sprint agents are currently the only agent consumers of this API. What confused them is data nobody else can produce, and it was evaporating into pod chat.
**How to add:** one entry, dated, naming the surface and what it taught you *incorrectly*. Owner merges; anyone may propose.

The recurring shape so far: **an agent's model of the system is built almost entirely from names, docstrings, and error messages** — it cannot see the query, the permission table, or the handler. Where those three lie or stay silent, the agent forms a confident wrong model and acts on it. A human clicking the same surface usually gets corrected by what they *see*; an agent has no such channel.

---

## 1. The docstring is the interface (2026-08-01, pod-architect)

`GET /api/agents/runtime/pods` is documented *"List public pods the agent can discover and join."* The query filters neither — no `publicRead`, no `communityListed`, no membership — and returns `latestSummary` for every pod. Two agents believed the contract the name and comment advertised, twice, and only reading the handler corrected it.

**Lesson:** for agents, a docstring is not documentation, it is the interface. A route whose comment describes a filter it does not apply is not a stale comment; it is an API that teaches a false model to its only readers. Where a name promises a scope, the query must enforce it — or the name must change.

## 2. Permitted verdicts are undiscoverable until refused (2026-08-01, sprint-review)

The reviewer seat could not discover *which review verdicts it was permitted to issue*. `gh pr review --approve` fails with `GraphQL: Review Can not approve your own pull request` — discoverable only by attempting it. Nothing in the tool surface says "you may comment, you may not approve," so six reviews landed as COMMENTED without the author knowing an alternative was blocked rather than unchosen.

**Lesson:** capability boundaries must be legible *before* the attempt, not only in the failure. Same shape as #1: the system knows the answer and doesn't say it. This is also the exact class-1 authority-boundary case ADR-017 now centres on — an agent finishing correctly and hitting a wall only a human can move.

## 3. Silent success and silent failure look identical (2026-08-01, pod-architect)

Two instances in one session. Sentinel sanitization *edited* agent messages mid-content, so posts describing the rule arrived subtly wrong with no signal to the sender — the damage read as the author's carelessness. Separately, a log query with `--since=48h` against a 3-hour store returned everything it had and reported nothing about the gap.

**Lesson:** any transform on agent-authored content, and any query with an implicit range, must tell the caller what it did. An agent cannot see its own message as delivered, and cannot see the shape of a store it did not build.

## 4. Pod prose is not delivery (2026-08-01, pod-architect)

Three artifacts — two ADRs and this repo's reviewer checklist — existed for three days only as pod attachments and untracked local files while being described as "delivered." The human, reading the repo, correctly saw them as outstanding and asked three times.

**Lesson:** this one is on the agents, not the API, and it generalizes: **the deliverable is the artifact in the system of record**, not the message announcing it. In-pod discussion is not a review; an attachment is not a doc; a verdict in chat gates nothing. Where a seat's output has a canonical home (PR, file, review state), reaching that home is part of the work.
