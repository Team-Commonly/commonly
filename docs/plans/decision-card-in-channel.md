# The decision card in the channel — Telegram and Slack, per ADR-029 D5

**Goal:** Sam, 2026-09-05 — *the workspace is the preview*, and the decision loop closes both ways. An agent's fork reaches the human where they are, the human answers there, and the asking agent wakes the same way it would from the workspace. **Spec basis:** [ADR-029](../adr/ADR-029-attention-delegate.md) D3 (attribution, never paraphrase), D4 (a DecisionRequest is an *interrupt*), D5 (the relay chokepoint), D6 (the ledger). **Model:** `backend/models/DecisionRequest.ts` and `decisionRequestService.ts` at main `c69ac7fc`. **Builder:** Kai, TASK-011, the day Sharpen's PR 3 lands the card shape. **Rule carried over:** the channel never renders a control the server does not enforce — a reply resolves a card only through the verb the Activity page already uses.

The one contract this note depends on is §1. If Sharpen's PR 3 changes the card's fields, §1 is the only place to re-key; every decision below reads from it.

## 1. What exists, and what the channel needs from it

**The card.** `POST /api/agents/runtime/decisions` (`agentsRuntime.ts:3710`) → `requestDecision`: the asker's own message is posted first through `AgentMessageService.postMessage` with `metadata.source: 'decision-request'` and content `title / question / context / Options: - label (recommended) — description`; then the `DecisionRequest` row is created with `messageId` = that message. Fields the channel reads: `title` (≤160), `question` (≤1000), `options[2..4]` `{ label ≤80, description? ≤280, recommended? }`, `context?` (≤2000), `messageId`, `status: pending | ruled`, `ruling { value, byUsername, at, messageId }`.

**The ruling.** `chooseDecision({ decisionId, callerUserId, value })` is the only writer: human pod member only (bots 403), a two-minute `rulingLock` CAS, the ruling posted as a **threaded human reply to the ask message** (`postRulingReply` → `PGMessage.create(…, replyTo = messageId)` → `deliverMessageToAgents`), then `status: 'ruled'` and `attentionItemService.resolve`. The reply is what wakes the asker — in this codebase *the `decision.ruled` event is that threaded reply*, not a separate queue type. A second call answers `409 { error: 'Decision already ruled', decision }` with the standing ruling. `value` is free text: the Activity card sends an option's label, or the *Other…* text.

**The relay.** Every agent post reaches the channel through one seam: `agentMessageService.ts:1789` → `eventHandlers.dispatch('chat.message', { podId, agentUsername, displayName, content, podMessageId })` → `telegram.relay` / `slack.relay` on each active parent. Both bridges gate on `shouldEscalate` (`connectorRelayPolicy.ts`: mirror mode, lead agent, `[DECISION]`-class markers, or a question at an `@human`), send `<b>{agent}</b>: {content ≤900}` + *open in Commonly* (Telegram, HTML) or `[{pod}] {agent}: {content ≤900}` (Slack, plain text), and append `{ tgMessageId | externalMessageId, agentUsername, podMessageId }` to `config.relayMap` (cap 100). **A card does not match the markers** — `formatDecisionMessage` writes none — so today a fork reaches the phone only in mirror mode or when the asker is the lead. That is the first thing to fix.

**The reply.** Telegram: a quote-reply (`reply_to_message.message_id`) hits `relayMap` → `routeReplyContent` prefixes `@{agent}` and the message is posted into the pod **unthreaded** (`PGMessage.create(…, null, null, null)`). Slack: `thread_ts` → `routeSlackReplyContent`, same shape. Neither writes a ruling. The reply reaches the asker as an ordinary mention, and the card stays `pending` in the workspace.

## 2. Decisions

**D1 — A card is an interrupt by kind, not by regex.** `requestDecision` hands the card to the relay: the `chat.message` payload gains `card?: { decisionId?, title, question, options, context? }` (the row does not exist yet when the message posts, so `decisionId` may be absent; §2 D3 resolves by `podMessageId` instead). Both bridges treat `card` as ADR-029 D4's *interrupt*: it skips `shouldEscalate`, honours `relayMutedUntil` (mute means mute) and `adminPause`, and is otherwise sent regardless of mode or lead. No marker text is added to the pod message to trick the regex.

**D2 — The card renders as numbered options, whole.** The bridge renders from `card`, never by re-parsing the content:

```
{agent} needs a ruling · {title}
{question}

1. {label}   ★ recommended
   {description}
2. {label}
   {description}

Reply to this message with a number, or write your ruling.
open in Commonly → {link to the thread}
```

Rules: the title and question are never trimmed; each description is trimmed to 100 characters with `…`; `context` is never sent (the link carries it — D3, *"…more in the workspace"*, and the 900-character cap does the arithmetic: 160 + 1000 already exceed it, so the cap moves to **1900 for cards** and Telegram's 4096 is the ceiling); the recommended option carries ★ and the word, never a different colour or emoji; options keep the asker's order — the numbers are the contract for the reply. Telegram uses `<b>` for the first line and the labels, nothing else; Slack sends the same text with `*bold*`. The link goes to the ask message's thread (`/v2/pods/{podId}?message={messageId}`), not the pod root. No buttons in v1 (§7).

**D3 — A reply to the card is a ruling, through the same verb.** A card's channel record is **durable, not a window** (Vera, 63929): `relayMap` is capped at 100 and a busy chat evicts a card while its row is still `pending`, after which a reply would silently become chat. So the bridge writes a card to `config.cards: [{ podMessageId, tgMessageId | externalMessageId, sentAt, closedAt? }]` at relay time, beside the ordinary `relayMap` entry. Closing a card (D6) **marks** `closedAt`; it never removes the entry — removal is the sweep's, seven days after `closedAt`, never by count (Vera, 63957: a `$pull` on confirm races the other chats' replies, and a reply that arrives after its entry is gone would fall through to `relayMap` and relay as chat instead of hearing *Already ruled*). "A card you can still reply to" means *a card in `cards`*; an open card is one with no `closedAt`. In both bridges, before the inbound message is posted, a quote-reply is matched against `cards` first — open **or closed** — (then `relayMap` for ordinary lines, unchanged), and the hit's `podMessageId` is looked up: `DecisionRequest.findOne({ messageId: podMessageId })`. A hit whose row is already `ruled`, or whose entry carries `closedAt`, takes D4's *Already ruled* path and never falls through to chat. If the row is `pending`, the reply is parsed:

| reply text | value passed to `chooseDecision` | channel answer |
|---|---|---|
| a bare integer `n` with `1 ≤ n ≤ options.length` | `options[n-1].label` | `✓ Ruled: {label}` |
| a bare integer out of range | nothing written | `Pick 1–{N}, or write your ruling.` |
| anything else (free text) | the text, trimmed, ≤2000 | `✓ Ruled: {text}` |

**A reply is not an authorization** (Vera, 63917). Before the verb is called, the resolver binds three things, in this order, and stops at the first miss with nothing written: **the chat** — the card is looked up in *this* integration's `relayMap`, so a reply can only resolve a card that was sent to the chat it came from; **the identity** — the inbound predicates the bridges already refuse on stay in front of the resolver (Telegram `chat.type === 'private'`, the reason group chats are refused; Slack `event.user === config.slackUserId`), and the caller passed to the verb is `config.linkedUserId`, never anything derived from the message; **the card** — `status: 'pending'` at lookup, and the verb's own CAS after it. The call is `chooseDecision({ decisionId, callerUserId: linkedUserId, value })`; the verb re-checks that the linked user is a human pod member. **First reply wins by CAS, not by read-then-write:** the bridge never touches the row — the verb's `findOneAndUpdate({ status: 'pending', rulingLock absent-or-expired })` is the only write, so two replies in the same tick produce exactly one ruling and one `409`. On success the ruling lands in the workspace exactly as an Activity-card ruling does: threaded reply under the ask, asker woken once, attention item resolved, socket broadcast. **The reply is not also posted as an ordinary inbound message** — one human sentence becomes one workspace message, the ruling. The channel confirmation is a reply to the card (`reply_to_message_id` = the card's `tgMessageId`; Slack `thread_ts`), sent by the bridge in its own voice, not attributed to an agent.

**D4 — A late second reply changes nothing, and says so.** A second reply to a ruled card gets `409` from the verb. The bridge answers in the channel, as a reply to the card: `Already ruled {rel} by {by}: {value}. To change it, the agent asks again — say so in the workspace:` + the thread link. The second reply's text **is** posted into the pod as an ordinary threaded reply under the ask (so the words are not lost and the asker sees them), but the ruling is a recorded fact (ADR-028) and does not move. A reply while the two-minute lock is held by another tab answers `Someone is ruling this right now — try again in a moment.` and posts nothing.

**The verb has three more outcomes, and a throw is a code, not a failure** (Vera, 63928). The bridge switches on `status`/`code` and never falls back to "post the text as an ordinary message" — that fallback is exactly what double-posts to the asker in the third case:

| outcome | what already happened in the workspace | channel answer | bridge posts |
|---|---|---|---|
| `403` *Only human pod members can rule* — the owner left the pod after the card was sent | nothing | `You're no longer in {pod}, so this ruling can't be recorded. Open it in Commonly:` + link | nothing |
| `503 ruling_not_posted` — the threaded reply could not be written; the lock is released, the card stays open | nothing | `Couldn't record that — nothing was saved. Try again in a moment.` | nothing; the same reply retried rules normally |
| `409 ruling_finalize_conflict` — the reply **is** posted and has woken the asker, but the row did not flip to `ruled` | one threaded reply, one wake | `Your ruling reached the workspace, but the card didn't close. Open it in Commonly to confirm:` + link | **nothing** — a second post here is the double-post |

The third row is the one the table exists for: the human's words are already in the thread, so the only honest channel line is *it reached, confirm there*, and the workspace card (still `pending`) is where the row gets closed — by the same verb, which will post a second reply only if a human rules again, which is today's behaviour and not this note's to change.

**D5 — A bare number resolves the one open card.** People do not quote-reply on a phone. A message that is *only* an integer (`^\s*\d{1,2}\s*$`), sent to a chat that has **exactly one** open card in `cards` (no `closedAt`, row still `pending`), is treated as a reply to that card (D3). Not `DecisionRequest.find({ podId, status: 'pending' })`: under D8 gates one connector relays cards from several pods, and a pending fork that was never sent to this chat is not one the human can see. With two or more pending, the bridge answers `Which one? Reply to the card you mean.` and posts nothing. With none, the number is an ordinary message and relays as today. Anything longer than a bare number never resolves a card without a quote-reply — free-text rulings need the quote so a passing sentence is never read as a ruling.

**D6 — A ruling from the workspace closes the card in the channel.** When `chooseDecision` succeeds, the service asks the bridges to confirm wherever the card was shown: `Integration.find({ 'config.cards.podMessageId': row.messageId, isActive: true })` → for each, send `✓ Ruled by {by}: {value}` as a reply to that card and set the entry's `closedAt`. Marking, not pulling, is what keeps D4 reachable from every chat after the ruling: a reply from another member that lands after the winner's confirmation still finds its entry and hears *Already ruled* (D9), whether it arrives a second or a day later. The reconciler's five-minute sweep sets `closedAt` on any entry whose row is **not `pending`** — `ruled`, or missing altogether (a purged decision, a deleted pod) — so a confirmation that failed to send, or a row that vanished, cannot leave a card looking open (Vera, 63950); and it **removes** entries whose `closedAt` is older than seven days, which bounds `cards` to open forks plus a week of closed ones. A reply to a card older than that falls through to `relayMap` and is ordinary chat, which is honest: the thread link in the workspace is the record by then. Without this a phone shows an open card for a fork that was ruled at a desk ten minutes earlier, and the next "2" from the phone meets D4 without warning. Fire-and-forget, like every relay; a failed confirmation is a log line, never a failed ruling.

**D7 — The ledger records the round trip, and this is where it lives.** ADR-029 D6 names the ledger and ADR-028 leaves its storage open (§Ratification points), so nothing owns a verdict today: `AttentionItem` is a human's queue keyed by recipient, `AuditLog` is admin actions, `Activity` is the feed. None of them is a per-channel record of what the bridge decided. PR 1 creates the owner (Kai, 63958) — **one model, one service, born with the shape ADR-029 D6 needs and the single writer this note needs:**

```ts
// backend/models/ChannelVerdict.ts
{
  integrationId: ObjectId,            // the channel binding (the Integration row)
  installationId?: ObjectId,          // its parent, when installable-backed
  podId: ObjectId,                    // the workspace the event came from
  provider: 'telegram' | 'slack',
  event: { kind: 'decision_request' | 'chat.message', podMessageId: string, decisionId?: ObjectId },
  verdict: 'interrupt' | 'digest' | 'hold',
  reason: string,                     // 'card' | 'marker' | 'mirror' | 'lead' | 'question' | 'muted' | 'paused' | 'gate_off' | …
  at: Date,
  reachedHumanAt?: Date,
  ruledVia?: 'telegram' | 'slack' | 'workspace',
  expiresAt?: Date,                   // set when the row is finished; the TTL index reads this, never `at`
}
// indexes: { integrationId, at }, { podId, at }, { 'event.podMessageId' }, and { expiresAt } TTL with expireAfterSeconds: 0
```

`backend/services/channelVerdictService.ts` exposes `record(entry)`, `markReachedHuman({ podMessageId, integrationId, ruledVia })` and `markRuled({ podMessageId, ruledVia })`. The two stamps mean different things per row (Vera, 63971): `reachedHumanAt` is **this channel's** human acting here, so `markReachedHuman` requires `integrationId` and stamps exactly one row; `ruledVia` is how the **fork** was settled, one value for all rows of that `podMessageId`, so both functions stamp it on every row. Under D9 a fork with three copies ends as one row *reached, ruledVia telegram* and two rows *not reached, ruledVia telegram* — which is the honest reading of "who answered, and where". A workspace ruling calls `markRuled` only: no row gains `reachedHumanAt`. PR 1 writes exactly one kind of entry — `verdict: 'interrupt', reason: 'card'` from both bridges when a card is sent — and `'hold'` with `reason: 'muted' | 'paused' | 'gate_off'` when a card is not sent to a member (D9), so the day's ledger shows a fork that reached two phones and skipped a third. PR 2 stamps `reachedHumanAt` + `ruledVia` from the channel; PR 3 stamps `ruledVia: 'workspace'`. The `decisionId` is filled lazily on first lookup (§1: the row does not exist when the card relays). **Retention is a TTL, decided now, and the clock runs from *finished*, not from *written*** (Vera, 63971 and 63975): once ADR-029's build writes a verdict per relayed message per channel, this is the busiest connector collection, so rows expire — but a card's row is not finished when it is written (PR 2 stamps `reachedHumanAt`/`ruledVia` later, and §7 lets a fork stay pending indefinitely), and a clock on `at` would delete the row exactly before it carried the fact D7 exists to hold. So the TTL reads an explicit `expiresAt`: `record()` sets it to `at + 90 days` for rows that are complete at write (every ordinary relay, and every `hold`), and leaves it **unset** for a card's `interrupt` row; `markReachedHuman` and `markRuled` set it to `now + 90 days` on every row of the fork they stamp. An unruled card's ledger row is therefore as durable as the fork itself — the same bound as `cards` (D3) and the same reason §7's expiry has a second life. Ninety days covers the day's ledger (D6), a quarter of owner counts, and the benchmark's scripted days (ADR-029 §6), and nobody migrates an index later to add it. The verdict enum carries all three values so ADR-029's own build adds *writers* for ordinary relays, not a second model; the D6 surface (the day's ledger per channel) reads this collection and nothing else. The DecisionRequest row itself does not gain a channel field — the ledger is where "which surface answered" lives. Fire-and-forget, like the relay: a failed ledger write is a log line, never a failed card.

**Who reads it: the owner, under the same authorisation as the row it describes** (Vera, 63970). A `hold / muted` entry is a fact about a named person's private configuration at a point in time — `integrationId` resolves to `linkedUserId` — and D8 Phase 2 drew the line that an admin may stop a connector and may not read what its owner configured. So a `ChannelVerdict` is readable only by the `linkedUserId` of its `integrationId`, through the same owner-only check the Integration PATCH uses; the D6 surface (the day's ledger per channel) is the owner's page, keyed by their own connectors. There is no admin read of rows. If an admin surface ever needs the ledger, it gets **counts per pod per verdict**, never `reason` and never per-integration rows — the same way the pause lever gets a verb and not the config. The asking agent is not a reader either: it learns the ruling from the threaded reply, not from the ledger.

**D8 — Under the delegate, the card is the delegate's message.** When ADR-029 D5's chokepoint lands (only the delegate posts to the channel), the card is relayed by the delegate with D3 attribution — `{asker} needs a ruling · {title}` already names the asker on line one, so nothing else changes. The confirmation lines (D3, D4, D6) stay the bridge's own voice. The asker is addressable from the channel (`@{asker}`) for a follow-up question that is not a ruling.

**D9 — A card is addressed to the pod, and reaches every phone gated to it.** D8's outbound inversion (#1550) fans `dispatch` out to every pod member's connector whose gate for that pod is on, so one fork produces one card per member, and `chooseDecision` lets **any human pod member** rule — the channel copies are equal, none is the owner's (Vera, 63940). Consequences, stated so nobody reads them as bugs: D5's "one open card" is **per chat** — three members hold three copies of the same card, each with its own `cards` entry. Two of them typing `2` at once is 9b(e) arriving from different chats: the verb's CAS still makes exactly one ruling; the loser's chat gets D4's *Already ruled {rel} by {by}: {value}* line, and their text lands under the ask like any late reply. D6's confirmation goes to **every chat that got the card**, not only the one that answered — the answering chat reads *✓ Ruled: {label}*, the others *✓ Ruled by {by}: {value}* — which is why D6 looks up integrations by `cards.podMessageId` rather than remembering who replied — and marks rather than removes, so B's reply arriving after A's confirmation still finds its entry. A member who has `/mute`d, or whose gate for that pod is off, or who is admin-paused, **does not receive the card** (D1: mute means mute, and a gate is the member's own switch); their copy is never in `cards`, a bare number from them is an ordinary message, and D6 sends them nothing. That is a choice: the card is an interrupt like any other, and a person who has said *not now* is not interrupted for a fork either — the fork is in the workspace, where their `/unmute` or the Activity page finds it.

## 3. Reply grammar, in one place

| what the human sends | to | result in the workspace | what the channel says back |
|---|---|---|---|
| `2` as a quote-reply to the card | pending card | ruling = option 2's label, threaded under the ask; asker wakes | `✓ Ruled: {label}` |
| `2` bare, one pending card in the chat | that card | same | same |
| `2` bare, two pending cards | — | nothing | `Which one? Reply to the card you mean.` |
| `2` bare, no pending card | — | ordinary message, relays as today | nothing |
| `7` as a quote-reply, card has 3 options | — | nothing | `Pick 1–3, or write your ruling.` |
| `2` as a quote-reply to a card sent 150 messages ago | that card (`cards`, not the `relayMap` window) | ruling = option 2's label | `✓ Ruled: {label}` |
| `ship it, but behind the flag` as a quote-reply | pending card | ruling = that text | `✓ Ruled: ship it, but behind the flag` |
| `2` from member B while member A's `2` is in flight, different chats | one card, two copies | one ruling (CAS); B's text lands under the ask | A: `✓ Ruled: {label}`; B: `Already ruled {rel} by {A}: {label}`; every other chat that got the card: `✓ Ruled by {A}: {label}` |
| any reply to a ruled card | ruled card | the text lands as a threaded reply under the ask; ruling unchanged | `Already ruled {rel} by {by}: {value}. …` |
| a reply while another tab holds the lock | — | nothing | `Someone is ruling this right now — try again in a moment.` |
| a reply after the owner left the pod | — | nothing (`403`) | `You're no longer in {pod}, so this ruling can't be recorded. …` + link |
| a reply when the threaded write fails | — | nothing (`503 ruling_not_posted`, lock released) | `Couldn't record that — nothing was saved. Try again in a moment.` |
| a reply when the reply posts but the row does not flip | the ruling reply is in the thread and woke the asker (`409 ruling_finalize_conflict`) | `Your ruling reached the workspace, but the card didn't close. …` + link — and **no** further post |
| `/mute` then a card is asked | — | card not sent; the ask is in the workspace | nothing until `/unmute` |
| admin pause, then a reply | — | acknowledged and dropped (D8 Phase 2 seed 10) | nothing |

## 4. What the card looks like

Telegram (HTML, one message):

```
<b>vale needs a ruling · Ship the connector catalog behind a flag?</b>
The catalog route is ready; the page is not. Flag it, or hold both?

<b>1.</b> Flag it   ★ recommended
   Route ships dark; page follows next week.
<b>2.</b> Hold both
   One press, one smoke.

Reply to this message with a number, or write your ruling.
<a href="…/v2/pods/{podId}?message={messageId}">open in Commonly</a>
```

Slack (text, one message in the DM):

```
*vale needs a ruling · Ship the connector catalog behind a flag?*
The catalog route is ready; the page is not. Flag it, or hold both?

*1.* Flag it   ★ recommended
   Route ships dark; page follows next week.
*2.* Hold both
   One press, one smoke.

Reply in this thread with a number, or write your ruling.
open in Commonly → …/v2/pods/{podId}?message={messageId}
```

Confirmation, both: `✓ Ruled: Flag it` as a reply/thread message under the card.

## 5. Sequence and sizes

| PR | what | size | depends on |
|---|---|---|---|
| 1 | D1 + D2: `card` on the dispatch payload from `requestDecision`; both bridges render it, skip `shouldEscalate`, respect mute and pause; card cap 1900; ledger entry (D7 write side) | S–M | Sharpen's PR 3 (card shape) |
| 2 | D3 + D4 + D5: reply → `DecisionRequest` by `podMessageId` → parse → `chooseDecision`; confirmations; bare-number rule; second-reply path posts the text under the ask | M | 1 |
| 3 | D6 + D7 read side: workspace ruling confirms in the channel; `ruledVia` | S | 2 |

PR 1 alone is already a product change — forks reach the phone in attention mode — and can press before 2.

## 6. Acceptance seeds (for Vera's plan)

1. **Interrupt by kind.** Connector in attention mode, no lead, asker not the lead → the ask relays; a plain agent post from the same asker does not. `/mute` → the card does not relay; `adminPause` → does not relay.
2. **Render.** Four options with 280-char descriptions → one Telegram message under 1900 chars, four numbered lines, ★ on the recommended one, no `context` text, the link carries `message={messageId}`. Order equals `options` order.
3. **Quote-reply rules.** Reply `2` to the card → `chooseDecision` called once with `options[1].label`; the pod gains exactly one message, threaded under the ask, authored by the linked user; the asker wakes once; `status: 'ruled'`; the channel gets `✓ Ruled: {label}` as a reply to the card. No unthreaded inbound message exists.
4. **Free text rules.** Reply `ship it, but behind the flag` → ruling value equals the text; same assertions.
5. **Out of range.** Reply `7` on a three-option card → nothing written, channel hint names `1–3`.
6. **Second reply.** After 3, reply `1` → 409 path; ruling still option 2; the pod thread gains the text `1` as a reply under the ask; the channel says `Already ruled … by {linked user}: {label}`.
7. **Bare number.** One pending card: `2` alone rules it. Two pending cards: `2` alone → `Which one?`, nothing written. None pending: `2` alone → ordinary relay, nothing ruled.
8. **Workspace first.** Rule from the Activity card, then reply `1` from Telegram → 409 path; and before that reply, the channel already received `✓ Ruled by {by}: {value}` as a reply to the card (D6).
9. **Lock.** Hold the `rulingLock` with a live token, reply `2` → `Someone is ruling…`, nothing written; after expiry the same reply rules.
9b. **A reply is not an authorization.** (a) A Telegram update whose `chat.type` is `group`, on a chat that somehow matches a live row → dropped before lookup, `chooseDecision` never called. (b) A Slack event with `event.user !== slackUserId` in the DM that received the card → dropped before lookup. (c) A quote-reply in chat B to a `message_id` that exists only in chat A's `relayMap` → no hit, ordinary message, nothing ruled. (d) The caller recorded on the ruling is `config.linkedUserId`, never the sender name. (e) Two replies to the same card delivered concurrently (two webhook requests in flight) → exactly one `ruling`, one `✓ Ruled`, one `Already ruled` or `Someone is ruling…`; the verb's CAS is the only arbiter and the bridge holds no state of its own.
10. **Slack twin.** Seeds 3, 4, 6 with `thread_ts`; a top-level bare number follows seed 7; `event.user !== slackUserId` is dropped before any lookup.
12. **Owner left the pod.** Card sent, owner removed from the pod, reply `2` → verb answers 403; nothing written, no unthreaded post; channel line names the pod and links the thread.
13. **Write fails.** Make `PGMessage.create` throw once → `503 ruling_not_posted`; the row is `pending` with no lock; nothing posted; the channel says nothing was saved; the same reply sent again rules normally (one ruling, one wake).
14. **Finalize conflict.** Make the final `findOneAndUpdate` return null → the thread holds exactly **one** human reply, the asker woke exactly once, the row is still `pending`, and the bridge posted **nothing else** — the channel line says it reached and links the thread. A bridge that posts the text as an ordinary message here fails this seed.
15. **No window.** Card sent, then 150 ordinary relays into the same chat (the `relayMap` cap is 100) → a quote-reply `2` to the card still rules it, and a bare `2` still counts it as the one open card. After the ruling, the entry carries `closedAt` and is still there; a quote-reply the next day hears *Already ruled*; after a failed confirmation the sweep marks it within one pass; eight days later the sweep has removed it and the same quote-reply is ordinary chat.
16. **One fork, three phones.** Pod with members A, B, C, all gated on; C has `/mute`d. The card reaches A and B (two `cards` entries, on two integrations) and not C. A and B reply `2` and `1` concurrently → exactly one ruling; the winner's chat gets `✓ Ruled: …`, the loser's gets `Already ruled … by {winner}: …` and their text is under the ask — **and the same holds when the loser's reply is processed after the winner's D6 confirmation has already marked the loser's entry** (the entry is marked, not pulled, so the reply never falls through to chat; this seed runs both orderings); C gets nothing at any point, and a bare `2` from C after `/unmute` relays as an ordinary message. Then rule a fresh card from the workspace → A's and B's chats both get `✓ Ruled by {by}: {value}`, C's does not; both entries carry `closedAt`.
11. **Ledger.** After 3: one entry `{ event: 'decision_request', verdict: 'interrupt', reachedHumanAt, ruledVia: 'telegram' }`; after 8: `ruledVia: 'workspace'`.

## 7. Not decided here

- **Slack buttons.** Block Kit buttons need an interactivity request URL and a second signed endpoint; the events URL alone is the open smoke question (63528). Text-and-number first; buttons when the Slack app has one more URL to misconfigure.
- **Expiry.** `DecisionRequest` has no expiry and no cancel. A card that is never ruled stays open in both places; when the model gains either, the channel gets a `Withdrawn` line the way D6 gets `Ruled`. There are now three reasons for it, not one: a stale card in two UIs; `cards` — bounded by open forks plus a week of closed ones, and read on every inbound message to that chat — whose open entries have no other way to shrink for a fork nobody will ever rule (Vera, 63950); and, strongest, the ledger (D7): a `ChannelVerdict` row is finished by a ruling, `expiresAt` is set only then, and a TTL with `expireAfterSeconds: 0` ignores documents without the field — so the rows for the forks least likely to be missed are the ones with **no bound at all** (Vera, 64053). The clock-from-finished rule is still right; what it exposes is that *finished* needs a third way to happen. The recommendation to whoever owns `DecisionRequest`: an expiry (`status: 'expired'` after a fixed window, 30 days as a starting number) is one write that finishes all three — the card gets `closedAt` and a *Withdrawn* line, the ledger row gets `expiresAt`, and the workspace card stops looking open. Until then, abandoned cards are rare and every entry is a few fields; nothing changes today, and this paragraph is the record of why it must change eventually.
- **Group chats.** D3 rests on the DM being 1:1. A group binding (ADR-025 D7) would need the ruler's identity from `from.id`, which the bridge drops on purpose today.
- **Which surface the asker sees.** The asker's wake carries the threaded reply; whether the reply text says *via Telegram* is the existing `📱 … (via Telegram)` prefix question, unchanged here.
