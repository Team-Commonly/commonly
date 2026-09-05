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

**D3 — A reply to the card is a ruling, through the same verb.** In both bridges, before the inbound message is posted, the `relayMap` hit's `podMessageId` is looked up: `DecisionRequest.findOne({ messageId: podMessageId })`. If it exists, the reply is parsed:

| reply text | value passed to `chooseDecision` | channel answer |
|---|---|---|
| a bare integer `n` with `1 ≤ n ≤ options.length` | `options[n-1].label` | `✓ Ruled: {label}` |
| a bare integer out of range | nothing written | `Pick 1–{N}, or write your ruling.` |
| anything else (free text) | the text, trimmed, ≤2000 | `✓ Ruled: {text}` |

The call is `chooseDecision({ decisionId, callerUserId: linkedUserId, value })` — the owner of the DM is the only human who can type here (Telegram private chat; Slack `event.user === slackUserId`), and they must still be a pod member (the verb checks). On success the ruling lands in the workspace exactly as an Activity-card ruling does: threaded reply under the ask, asker woken once, attention item resolved, socket broadcast. **The reply is not also posted as an ordinary inbound message** — one human sentence becomes one workspace message, the ruling. The channel confirmation is a reply to the card (`reply_to_message_id` = the card's `tgMessageId`; Slack `thread_ts`), sent by the bridge in its own voice, not attributed to an agent.

**D4 — A late second reply changes nothing, and says so.** A second reply to a ruled card gets `409` from the verb. The bridge answers in the channel, as a reply to the card: `Already ruled {rel} by {by}: {value}. To change it, the agent asks again — say so in the workspace:` + the thread link. The second reply's text **is** posted into the pod as an ordinary threaded reply under the ask (so the words are not lost and the asker sees them), but the ruling is a recorded fact (ADR-028) and does not move. A reply while the two-minute lock is held by another tab answers `Someone is ruling this right now — try again in a moment.` and posts nothing.

**D5 — A bare number resolves the one open card.** People do not quote-reply on a phone. A message that is *only* an integer (`^\s*\d{1,2}\s*$`), sent to a chat that has **exactly one** pending card in its `relayMap` window, is treated as a reply to that card (D3). With two or more pending, the bridge answers `Which one? Reply to the card you mean.` and posts nothing. With none, the number is an ordinary message and relays as today. Anything longer than a bare number never resolves a card without a quote-reply — free-text rulings need the quote so a passing sentence is never read as a ruling.

**D6 — A ruling from the workspace closes the card in the channel.** When `chooseDecision` succeeds, the service asks the bridges to confirm wherever the card was shown: `Integration.find({ 'config.relayMap.podMessageId': row.messageId, isActive: true })` → for each, send `✓ Ruled by {by}: {value}` as a reply to that card. Without this a phone shows an open card for a fork that was ruled at a desk ten minutes earlier, and the next "2" from the phone meets D4 without warning. Fire-and-forget, like every relay; a failed confirmation is a log line, never a failed ruling.

**D7 — The ledger records the round trip.** ADR-029 D6: the card's relay writes `{ channel, event: 'decision_request', verdict: 'interrupt', reason: 'card', at }`; a ruling from the channel stamps `reachedHumanAt` and `ruledVia: 'telegram' | 'slack'` on the same entry; a ruling from the workspace stamps `ruledVia: 'workspace'`. The DecisionRequest row itself does not gain a channel field — the ledger is where "which surface answered" lives.

**D8 — Under the delegate, the card is the delegate's message.** When ADR-029 D5's chokepoint lands (only the delegate posts to the channel), the card is relayed by the delegate with D3 attribution — `{asker} needs a ruling · {title}` already names the asker on line one, so nothing else changes. The confirmation lines (D3, D4, D6) stay the bridge's own voice. The asker is addressable from the channel (`@{asker}`) for a follow-up question that is not a ruling.

## 3. Reply grammar, in one place

| what the human sends | to | result in the workspace | what the channel says back |
|---|---|---|---|
| `2` as a quote-reply to the card | pending card | ruling = option 2's label, threaded under the ask; asker wakes | `✓ Ruled: {label}` |
| `2` bare, one pending card in the chat | that card | same | same |
| `2` bare, two pending cards | — | nothing | `Which one? Reply to the card you mean.` |
| `2` bare, no pending card | — | ordinary message, relays as today | nothing |
| `7` as a quote-reply, card has 3 options | — | nothing | `Pick 1–3, or write your ruling.` |
| `ship it, but behind the flag` as a quote-reply | pending card | ruling = that text | `✓ Ruled: ship it, but behind the flag` |
| any reply to a ruled card | ruled card | the text lands as a threaded reply under the ask; ruling unchanged | `Already ruled {rel} by {by}: {value}. …` |
| a reply while another tab holds the lock | — | nothing | `Someone is ruling this right now — try again in a moment.` |
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
10. **Slack twin.** Seeds 3, 4, 6 with `thread_ts`; a top-level bare number follows seed 7; `event.user !== slackUserId` is dropped before any lookup.
11. **Ledger.** After 3: one entry `{ event: 'decision_request', verdict: 'interrupt', reachedHumanAt, ruledVia: 'telegram' }`; after 8: `ruledVia: 'workspace'`.

## 7. Not decided here

- **Slack buttons.** Block Kit buttons need an interactivity request URL and a second signed endpoint; the events URL alone is the open smoke question (63528). Text-and-number first; buttons when the Slack app has one more URL to misconfigure.
- **Expiry.** `DecisionRequest` has no expiry and no cancel. A card that is never ruled stays open in both places; when the model gains either, the channel gets a `Withdrawn` line the way D6 gets `Ruled`.
- **Group chats.** D3 rests on the DM being 1:1. A group binding (ADR-025 D7) would need the ruler's identity from `from.id`, which the bridge drops on purpose today.
- **Which surface the asker sees.** The asker's wake carries the threaded reply; whether the reply text says *via Telegram* is the existing `📱 … (via Telegram)` prefix question, unchanged here.
