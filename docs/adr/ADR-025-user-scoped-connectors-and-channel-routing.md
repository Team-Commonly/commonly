# ADR-025: User-scoped connectors and channel routing

**Status:** Proposed (2026-08-26). Acknowledged unknowns: inbound bare-message
routing default (D5) and digest cadence (D6) are guesses until measured.

**Scope boundary:** this ADR governs how a messaging channel binds to Commonly
and how messages route between a channel and pods. It does NOT govern what
crosses the attention gate (ADR-017/018 and the escalation gate in
`telegramBridgeService.shouldEscalate` own that), and it does not change the
Installable taxonomy — it *uses* ADR-001's `user` install scope.

## Context

The Telegram live bridge shipped 2026-08-26 (#1282, #1286, #1289, #1290) binds
one Telegram chat to one pod (`Integration.podId`), enabled by a connect code
minted from that pod. Two security decisions, each correct alone, compose into
a dead end:

- **#1289**: inbound relay is refused unless `chatType === 'private'` — in a
  group, attributing every sender's message to `config.linkedUserId` is
  impersonation, and Telegram gives us no per-sender Commonly identity.
- **Pre-existing**: one chat can claim one pod (`handleEnableCommand`'s
  chatClaim check) — correct while the binding is chat↔pod.

A user has exactly one private chat with the bot. Private-only × one-claim
means **a user can bridge exactly one pod, ever**. "Which pod does this
connector wire to?" is not a UX copy problem; the binding model is wrong.

## Decision

**D1 — The private chat binds to the USER, not to a pod.** A connector at
ADR-001 `user` scope: `Integration.scope: 'user'`, `linkedUserId` = the owner,
no `podId`. The chat becomes that user's attention surface for every pod they
are in. The existing pod-scoped connector remains as the special case for
team-group bridging, dormant until per-sender attribution exists.

**D2 — Transport is kernel; curation is agent.** Routing (tags, quote-reply
resolution, slash commands, digest schedule) is deterministic kernel code on
the integration. Agents decide what crosses (per-pod escalation gate, lead
agent, future LLM judge) and may compose answers — they never carry bytes. A
proxy agent doing transport means the phone goes dark when a seat hangs; seat
failure modes are measured and frequent.

**D3 — Outbound messages carry their pod.** Every relayed line is prefixed
`[PodName]` and `relayMap` entries gain `podId` alongside
`{tgMessageId, agentUsername, podMessageId}`. The map is the routing table.

**D4 — Quote-reply is the primary inbound router.** Replying to a relayed line
routes to that agent in that pod — exact, zero new UX, already 80% built.

**D5 — Slash commands cover cold starts.** `/pods` lists memberships;
`/pod <name>` sets the chat's active pod (stored on the integration); a bare
message goes to the active pod; `/tldr [pod]` returns an on-demand digest.
Guess to validate: bare-message-to-active-pod may surprise users — measure
misroutes before hardening.

**D6 — Digests are pushed per pod on a schedule**, reusing pod-summarizer,
each tagged `[PodName]`. Cadence starts daily; a guess until usage data.

**D7 — The judge routes only ambiguity.** A bare message with no active pod
and no quote is the single case that may invoke an LLM: ask one clarifying
question or infer. Everything else stays deterministic.

**D8 — Attribution invariants carry over unchanged.** Inbound posts are
authored as the integration's owner (server-derived, #1290 guard); the
private-chat gate (#1289) still applies; the user-scoped enable path derives
`linkedUserId` from the authenticated code-minter exactly as the pod-scoped
one now does.

## Consequences

- One phone chat per user, N pods behind it. The one-pod cap dissolves.
- `handleEnableCommand`'s one-claim check must distinguish scopes: a chat may
  hold one `user`-scoped binding (replacing the pod-claim rule for that scope).
- The Connectors page (#1290) grows a "personal connector" card above the
  per-pod list; per-pod live-relay toggles become per-pod *gate* settings on
  the user connector.
- Group chats stay read-only-ingest until per-sender identity mapping exists
  (Telegram user ↔ Commonly user), which is its own ADR when it comes.

## Alternatives rejected

- **N private chats via N bots** (one bot per pod): operationally absurd,
  Telegram-specific, and dies at Slack/Discord parity.
- **Commander agent as transport**: see D2. Also makes delivery latency a
  model-inference latency.
- **Group binding with per-sender trust**: blocked on identity mapping;
  reopening it now reopens the #1289 impersonation hole.
