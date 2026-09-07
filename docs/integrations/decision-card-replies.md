# Decision-card channel replies

Implementation of [the card note](../plans/decision-card-in-channel.md) D3–D5,
TASK-011 PR 2. The decision service remains the only DecisionRequest writer.

## Write boundaries

| Verb outcome | Bridge-authored pod message | Receipt | Ledger |
| --- | --- | --- | --- |
| 200 | None; the verb already posted the threaded ruling | Mark closed | Replying channel reached; whole fork settled via that provider |
| 403 | None | Unchanged | Unchanged |
| 409, already ruled | One ordinary threaded follow-up under the ask, not under the winning reply | Mark closed | Unchanged |
| 409, lock held | None | Unchanged | Unchanged |
| 503 `ruling_not_posted` | None | Unchanged | Unchanged |
| Thrown `ruling_finalize_conflict` | None; the verb already posted one reply | Unchanged | Unchanged |

An unexpected verb error gets a “check the thread before retrying” response:
it cannot safely be described as “nothing saved.” Confirmation transport and
close-stamp failures never retry the verb or fall through to ordinary chat.

The provider authenticates its private DM sender before card resolution.
Resolution uses only that integration's `config.cards`, never the pod's full
pending-decision list. The caller comes from the current webhook lookup's
`config.linkedUserId`, not a stored receipt. Membership is checked against the
card's pod before exposing a standing ruling or posting a late follow-up;
`chooseDecision` also checks it before acquiring its write lock.

The active-pod guard applies only to ordinary chat. A card can still be answered
with no active pod, or after leaving the active pod, if the person remains a
member of the card's pod (Wren's ruling in pod message 64265).

## Receipts and compatibility

`config.cards` is a server-owned array declared in the Integration schema;
outbound card sends append it alongside the bounded `relayMap`. It has no
count-based eviction. Existing integrations require no backfill to continue
ordinary chat. Only cards sent after PR 2 is deployed acquire durable receipts;
old PR 1 cards are not retroactively made reply-resolvable. Ask a fresh card for
the cutover smoke.

Owner PATCH writes individual top-level config fields, not a replacement
snapshot. This retains the existing one-level merge contract for fields such as
`gates`, while preventing a settings write from erasing concurrent card sends or
closure stamps. Client receipt writes and dotted update paths are refused or
stripped at the route boundary.

Workspace-originated confirmation fan-out and the five-minute/seven-day receipt
sweep belong to TASK-011 PR 3. PR 2 marks the answering chat; it does not claim to
have delivered sibling-chat or workspace-originated confirmations.

## Verification

`backend/__tests__/unit/services/decisionCardReply.bridges.test.js` runs both
provider bridges through the real decision service, MongoDB lock CAS, Integration
receipt writes and ChannelVerdict writes. PostgreSQL message storage, provider
network calls and event transport are mocked; these tests are not a live-send or
real-PostgreSQL claim. The overlapping-reply test blocks the first PG write while
the second invocation enters the real CAS. Lock expiry uses an injected clock.

Every refusal checks pod messages, receipts and ledger state. A deliberate
mutation adding a close stamp to the 503 catch fails both providers' `closedAt`
assertions. Additional cases cover 150 intervening relays, current-owner changes,
ghost cards, no active pod, and late replies from an already-marked sibling.

Transport contract tests pin Telegram's current
[`reply_parameters.message_id`](https://core.telegram.org/bots/api#sendmessage)
and Slack's [`thread_ts`](https://docs.slack.dev/reference/methods/chat.postMessage/)
to the original card. Telegram confirmations omit HTML parsing so a 2000-character
human ruling is literal text rather than escaped markup that could exceed the
provider limit; ordinary outbound HTML remains unchanged.
