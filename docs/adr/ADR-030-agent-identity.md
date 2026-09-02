# ADR-030 — Agent identity

**Status:** Proposed (stub — decision not yet made)
**Date opened:** 2026-08-01
**Renumbered:** 2026-09-01, from ADR-018. `main` carried two files at that number for 22 days
(this one and `ADR-018-agent-attention-claims.md`, Accepted 2026-08-17). This document declares no
D-numbered decisions, so every `ADR-018 D<n>` citation in the repo already resolves to
attention-claims; moving this file breaks none of them.

## Why this is open

An agent's identity in Commonly today is the pair `(agentName, instanceId)`.
That has been adequate while agents were few, owned by one person, and confined
to this instance. It is starting to cost us in three separate places, and the
costs are of different kinds — which is the signal that the model, not the
implementation, is what needs deciding.

### 1. It has already caused a cross-account leak

`(agentName, instanceId)` was keyed **globally**. A new user naming their agent
a name already taken joined the existing account's bot User row and its memory
(#609, fixed by owner-scoping at install; #648 tracks the full namespacing).
The identity was not wrong in implementation — it was under-specified. Nothing
in the pair says *whose* agent this is.

### 2. It does not travel

An agent's identity is meaningful only inside one Commonly instance. There is
no way to prove "this is the same agent" to anything outside — a second
instance, a GitHub repository, a third-party API. Federation ("ActivityPub for
agents") is stated ambition in the product framing and is not expressible in
the current model.

### 3. It cannot be a subject of authorization outside Commonly

The concrete case that surfaced it, 2026-08-01: four wrapper agents produced
pull requests and review reasoning. Making an agent's review actually **gate** a
merge requires branch protection, and branch protection requires the reviewer
to be a different GitHub principal from the author. All four agents act as the
operator's single GitHub identity, so GitHub sees one person and blocks
self-approval. Enabling required reviews would **deadlock** the pipeline rather
than gate it.

That is worth stating plainly: **the agents cannot be held to a process the
humans are held to, because they are not distinguishable principals.** Every
downstream system — GitHub, cloud IAM, an external API — sees the operator.

## The shape of the decision

Roughly three postures, and they are not mutually exclusive:

**A. Namespaced local identity.** Finish what #648 started: identity is
`(owner, agentName, instanceId)`, unique per instance, no cryptography.
Cheapest. Fixes the leak class. Does nothing for (2) or (3).

**B. Issued credentials per agent.** Each agent gets its own credentials in the
systems it acts on — a GitHub machine user or per-agent PAT, its own cloud
principal. Fixes (3) concretely and immediately. Operationally heavy: N agents
means N accounts to provision, rotate, and revoke, and some platforms price or
rate-limit per account.

**C. Portable cryptographic identity.** A keypair per agent, owner-signed
delegation, verifiable off-instance. Fixes (2) and (3) properly and is the only
posture that makes federation expressible. Largest change; touches the kernel,
the wrapper, and every driver.

Prior art worth reading before choosing, both from open-source products
shipping today: one issues per-agent keypairs with narrowly-scoped
owner-signed delegation, so a leaked agent key is revocable without touching
the human identity behind it. Another defines tiered verification levels
(anonymous → network-scoped → JWT → decentralized identifier) where each
network sets its own floor and the same agent can hold different levels on
different networks. The tiering idea is the more interesting of the two,
because it does not force one cost on every deployment.

## Open questions

- Is identity issued by the instance, by the owner, or self-generated and
  merely *attested* by the instance?
- What survives an agent moving between instances — the key, the memory, the
  reputation, none of it?
- Does a human need to be able to revoke one agent without disturbing the
  others, or the human identity behind them? (The delegation model makes this
  cheap; ours currently does not.)
- Do we need identity to be verifiable by third parties who do not trust our
  instance, or only by us? This is the question that decides whether (C) is
  necessary or merely elegant.
- What is the migration for agents that already exist, given identity
  continuity across reinstall is an ADR-001 invariant we have committed to?

## Deliberately not decided here

The **runtime tier** an agent runs on (BYO / cloud / VM-sandboxed) is a
separate concern and must stay separate — an agent's identity should not change
because its compute moved. That separation is already an ADR-001 principle and
this ADR must not erode it.

## Not yet decided

This stub exists to hold the shape of the problem so it is not re-derived from
scratch. It should not be cited as a decision.
