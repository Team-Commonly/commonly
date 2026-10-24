# Two-way chat connectors — one contract (TASK-079)

**Status:** Proposed, 2026-10-24. Nothing here is built.
**Asked by:** the CTO, after the long-term review ([long-term-review-2026-10.md](../architecture/long-term-review-2026-10.md), TASK-438).
**Design:** Wren. **Gate:** Rhea (docs). **Build:** unassigned. Rows are filed after the gate.
**Code read at:** `main` `36244e5a4`. Code paths are relative to `backend/`.

## What this answers

[ADR-025](../adr/ADR-025-connector-substrate.md) ends on a two-part question: "(a) give the four chat providers the verb the two social providers already have, and (b) decide whether mirroring is a product commitment at all" (ADR-025:566–567).

Two connectors have since answered (b) by shipping. Telegram has mirrored since #1282, which ADR-025 calls an answer "de facto for telegram, by shipping it" (:547). Slack followed in TASK-006 ([slack-as-installable-connector.md](slack-as-installable-connector.md)). Both converse today, and neither does it through the provider registry.

This note answers (a) for those two, and leaves (b) open for Discord and GroupMe. It applies three of ADR-025's decisions to the two connectors that already converse:

- D2, a conversational send verb in the provider contract (:251–256);
- D3, declared directions, with its third amendment's `control` (:258–290);
- D4, in its cheapest form (:292–295).

It ratifies none of them, and ADR-025 stays Proposed. ADR-025 also leaves D2's wire format open (:537–538), so every type below is internal to the backend. None of it is a published protocol.

## In short

- **Two bridges, one copied from the other.** `services/telegramBridgeService.ts` (662 lines) and `services/slackBridgeService.ts` (547 lines) each run the whole two-way flow for one platform. With platform names masked, 61% of Slack's code lines match Telegram's, in order (§1, §10).
- **A fix lands once per copy.** The instance-URL fix the review filed as TASK-285 has to land in both bridges. Six rules have already drifted apart (§5).
- **The proposal.** One core under `services/connectors/` owns every rule that reads the same on every platform. Each platform keeps an adapter that declares its facts and moves its bytes (§2, §3).
- **The bar.** All of a new chat connector's two-way logic is one adapter file. Around it sit a route that verifies the platform's signature, and five declarations (§8). No logic branch on the two-way path names a platform.
- **The cost.** About 7.5 implementor-days, in six additive steps (§7).

## Scope

**In:**

- outbound relay (an agent's post reaches the platform), inbound relay (a platform message reaches the pod), and quote-reply routing;
- decision cards: sending one, answering it by quote-reply, and closing it;
- the relay map, delivery failures and the control commands;
- ADR-025's D2 and D3, for Telegram and Slack.

**Out:**

- **ADR-027's phase 2**, two-way sync with a PM board ([ADR-027](../adr/ADR-027-pm-tool-projection-contract.md):254–260). Its trigger is "a team telling us the external board is where they edit, with the specific edit that got lost". Nothing here pulls it forward.
- **Hosted MCP** ([hosted-mcp-connection-scope.md](hosted-mcp-connection-scope.md)). It is a tool source, not a chat connector.
- **ADR-029's verdicts** ([ADR-029](../adr/ADR-029-attention-delegate.md)). Its D5 amendment puts the delegate check at "the single existing relay call" (ADR-029:40). The `shouldEscalate` step that amendment names runs once in each bridge today (`telegramBridgeService.ts:334`, `slackBridgeService.ts:250`). After step 2 (§7) it runs once, in the core, so D5 lands in one place whenever it is built.
- **Setup flows**: connect codes, OAuth, the enable commands and the Connectors page.

## 1. What is wrong

### Two bridges

Below, "tg" is `services/telegramBridgeService.ts` and "sl" is `services/slackBridgeService.ts`.

| Step | Telegram | Slack |
|---|---|---|
| Render a decision card | `renderTelegramDecisionCard` tg :91–125 | `renderSlackDecisionCard` sl :84–115 |
| Route a quote-reply | `routeReplyContent` tg :135–152 | `routeSlackReplyContent` sl :315–334 |
| Find the live binding | `findLiveIntegration` tg :154–178 | `findLiveIntegration` sl :175–188 |
| Outbound eligibility | `isRelayableIntegration` tg :180–192 | `isRelayableIntegration` sl :62–73 |
| Inbound eligibility | `isInboundRelayableIntegration` tg :197–208 | `isInboundRelayableIntegration` sl :119–130 |
| Relay an agent's post out | `relayAgentMessageToTelegram` tg :272–384 | `relayAgentMessageToSlack` sl :192–306 |
| Relay a platform message in | `relayTelegramMessageToPod` tg :389–650 | `relaySlackMessageToPod` sl :340–538 |

Each file defines the same constants for itself: a 900-character cap on a line and 1,900 on a card (tg :38–39, sl :27–28), and a 100-entry relay map (tg :37, sl :21). Their inbound pod lines differ only in the glyph and the platform name: `📱 ${senderName} (via Telegram): …` (tg :545–546) and `💬 … (via Slack)` (sl :451–452).

With comments, blank lines and platform names removed, 276 of Slack's 449 code lines match Telegram's 466, in order. That is 61% of Slack and 59% of Telegram. Leaving out short lines, such as a lone brace, gives 197 of 356, or 55% of Slack (§10).

### What they already share

The rules for who receives what are shared already. `services/connectorRelayPolicy.ts` (158 lines) exports `shouldEscalate`, `isGatedPodTarget`, `isRoutedPodTarget`, `isConnectorTargetPod`, `isListedPodMember` and `ESCALATION_MARKERS`. Four modules import it: both bridges (tg :29, sl :13), the card reconciler (`services/decisionCardReconcileService.ts:11`) and the card-reply router (`services/decisionCardReply.ts:12`). The dedupe store is shared too: `services/webhookDeliveryService.ts`, with `claimDelivery` at :11 and `releaseDelivery` at :36.

So the rules are shared, and the flow is not. Each bridge still does its own selecting, rendering, sending, failure handling, relay-map writing and inbound routing.

### What a copy costs

The review's item 3 found that on every instance but production, three readers of `PUBLIC_APP_URL` link to production: `telegramBridgeService.ts:340`, `slackBridgeService.ts:257` and `decisionCardReply.ts:76` (TASK-285). Two of the three are the same line, once in each bridge. Every rule a bridge holds works this way: a fix lands once per copy, and a third connector makes it three.

### Fourteen files name both platforms

14 backend product files name both `'telegram'` and `'slack'` (§10 has the command):

- **2 declare providers**: `integrations/index.ts` and `integrations/manifests.ts`.
- **4 are off the two-way path**: `routes/integrations.ts` (setup, CRUD and manual send), `routes/registry/provision.ts`, `routes/registry/reprovision.ts` and `services/schedulerService.ts`.
- **8 are on it.** One is the model, `models/Integration.ts`, which keeps its union and its enum (§4). The other 7 carry 16 lines that branch or validate on the two names:

| File | Lines | What the literal does |
|---|---|---|
| `models/ChannelVerdict.ts` | :9, :18 | lists the providers and the `ruledVia` values, which the schema enforces (:53, :61) |
| `services/channelVerdictService.ts` | :34 | narrows `ruledVia` to the two |
| `services/decisionCardReconcileService.ts` | :84, :96, :107 | checks the type, then branches health and sending per platform |
| `services/decisionCardReply.ts` | :40 | types `provider` as the two |
| `services/decisionRequestService.ts` | :72 | types `via` as the two, plus `workspace` |
| `services/installable/eventHandlers.ts` | :76, :92, :150 | selects bindings (twice), and keeps the pre-D17 fallback |
| `services/installable/projectors/webhookProjector.ts` | :9, :10, :11, :16, :81 | maps a webhook path to its provider, and revokes Slack's secret on removal |

A ninth file on the path names neither. `services/connectorDeliveryFailureService.ts` tells the two apart by the shape of their errors (:157, with the reasoning at :151–156).

### The registry was routed around

The provider contract has five verbs: `validateConfig`, `getWebhookHandlers`, `ingestEvent`, `syncRecent` and `health` (`integrations/index.ts:11–17`). None of them sends. `publishPost` is declared per provider (`integrations/providers/xProvider.ts:84`, `instagramProvider.ts:54`) and duck-typed at its one caller (`routes/agentsRuntime.ts:3775`).

The two-way path never touches the registry. The dispatcher keeps its own handler map, with `'telegram.relay'` and `'slack.relay'` (`services/installable/eventHandlers.ts:34–39`). The manual send route that does read the type answers Slack with `success: true` and `result: 'not-implemented'` (`routes/integrations.ts:633`). ADR-025's third amendment saw this twice: "when the registry's verb set did not fit, the implementation did not extend the registry — it added a route" (ADR-025:282–283).

### Capabilities are prose

Each manifest's `capabilities` list is free-form. Discord's is `['webhook', 'gateway', 'summary', 'commands']` (`integrations/manifests.ts:100`), and Slack's and Telegram's are `['webhook', 'summary', 'commands']` (:130, :168). Nothing checks them against the code. They sit in each manifest's `catalog` block, which `integrations/catalog.ts:51` publishes. Their one reader is the legacy chat room (`frontend/src/components/ChatRoom.tsx:1783`), which also keeps a hard-coded copy (:177–232).

## 2. Decisions

### §2.1 The split test

A rule that reads the same on every platform belongs to the core. A fact that names a platform belongs to the adapter.

"A relayed line carries its pod's name" is a rule. "A Telegram binding is keyed by its chat id" is a fact. Where a rule exists in two forms today, §5 picks one.

### §2.2 One core, one adapter per platform

The core and the adapters live under `services/connectors/`:

- `core.ts`: outbound relay, inbound receive, commands, and closing a card;
- `eligibility.ts`: one predicate per question, each beside its query form (§5, row 6);
- `adapters/telegram.ts` and `adapters/slack.ts`.

The platform clients stay as they are: `services/telegramService.ts` (74 lines) and `services/slackApi.ts` (99 lines). On the two-way path, an adapter calls its client and nothing else does.

### §2.3 Routes stay per platform

Signature checks and body parsing are security-relevant, and they differ by platform:

- Telegram checks a secret header (`verifyTelegramHeader`, `routes/webhooks/telegram.ts:67`, called at :433).
- Slack signs the raw bytes. `server.ts` captures them before parsing (:199, :209), and the route verifies them (`routes/webhooks/slack.ts:70`).

So each route keeps its own verification, then hands the event to the core: `core.receive(adapter, event, ack)`.

### §2.4 The adapter is the provider's converse facet (D2)

D2 asks for "`sendMessage(threadRef, content)` as a first-class provider method" (ADR-025:253–254). The adapter's `send` is that method.

Adapters are registered beside the provider factories (`integrations/index.ts:63–68`), in a backend map, `converseAdapters`. They don't go in the SDK's registry (`packages/integration-sdk`), because D2's wire format is still open (ADR-025:537–538). The dispatcher's `type: { $in: [...] }` (eventHandlers.ts:76, :92) reads the list of registered adapters.

D2 names Discord's send route (`routes/integrations.ts:619`) as "the reference implementation to lift into the registry" (ADR-025:255–256). This note applies D2 first to the two connectors that already converse. Discord's route stays as it is, because whether Discord converses is (b).

### §2.5 Additive

- `internal:telegram.relay` and `internal:slack.relay` keep resolving, so no installed row changes.
- The pre-D17 fallback for Telegram rows with no installation stays (eventHandlers.ts:142–153). The Telegram adapter declares it (`servesDirectRows`).
- The bridges' exports (tg :652–660, sl :540–547) become wrappers over the core until their last caller moves.

## 3. The contract

### What goes where

| Concern | Core (one copy) | Adapter (one per platform) |
|---|---|---|
| Who receives a post | binding selection; gates, mute, admin pause and escalation (`connectorRelayPolicy.ts`); verdicts, holds included (eventHandlers.ts:70–73) | — |
| What a line says | the pod tag, the author, the caps (900, or 1,900 with a card), and one Commonly link from one instance-URL source | `render`: markup and escaping |
| Sending | one send per line; the relay-map and card writes (cap 100) | `send`, which returns a `SendResult` |
| A failed send | the flip, only on `unreachable`, only for a send to the binding's own chat | mapping platform errors to a `SendResult` |
| Inbound | the private-chat gate; quote-reply routing, re-checking the routed pod; membership; authoring as the owner; the Postgres backfill and thread root; the write; delivery and the socket emit; no throw after the write | `parseInbound` and `bindingKey` |
| Commands | the command set, what each does, and every reply text; `proveSender` before any command that writes | `proveSender`, and how a reply leaves (`commandReply`) |
| Notices | the text a sender sees when a message can't be routed | — (sent through `send`) |
| Dedupe and ack | the claim and the release (`webhookDeliveryService.ts`) | the key, the TTL, what to do when the store is down, and when to ack |
| Removal | deactivating the row | `secretRefs`, revoked on removal (replacing `webhookProjector.ts:81`) |

Quote-reply routing keeps the rule both bridges already state: "the map is data" (tg :131–134, sl :312–314). A pod read from the relay map is re-checked through `isRoutedPodTarget` at reply time. It is never trusted because it was stored.

### The adapter interface

This is a sketch, not final code:

```ts
type Binding = IIntegration;               // the stored row; no new model

// What the core asks an adapter to deliver. Every field is plain text.
interface OutboundMessage {
  podName: string;                         // the [PodName] tag (ADR-025 D10)
  author?: string;                         // absent on a notice
  text: string;                            // already capped by the core
  link?: string;                           // the Commonly link
  card?: DecisionRelayCard;                // services/decisionCardRelay.ts
  replyTo?: string;                        // the external id this line answers
}

type SendResult =
  | { kind: 'delivered'; externalId: string }
  | { kind: 'unreachable'; reason: string }      // the bound chat is gone or blocked us: flip
  | { kind: 'throttled'; retryAfterMs?: number }
  | { kind: 'rejected'; detail: string }         // content, or the shared app's credential: never flip
  | { kind: 'ambiguous'; detail: string };       // 5xx, timeout, unclassified: never flip

interface InboundMessage {
  externalId: string;
  chatId: string;
  chatType: string;
  senderId: string | null;
  senderName: string | null;
  text: string;
  replyToExternalId: string | null;
  command?: { name: string; argument?: string };
}

interface ChatAdapter {
  type: string;                            // its Integration.type
  label: string;                           // 'Telegram', as in "(via Telegram)"
  glyph: string;                           // '📱'
  privateChatType: string;                 // 'private' | 'im'
  servesDirectRows?: boolean;              // Telegram only: rows from before D17
  bindingKey(message: InboundMessage): Record<string, unknown>;
  isBindingHealthy(binding: Binding): boolean;
  render(message: OutboundMessage): string;
  send(binding: Binding, message: OutboundMessage): Promise<SendResult>;
  parseInbound(event: unknown): InboundMessage | null;
  proveSender(binding: Binding, message: InboundMessage): boolean;
  commandReply: 'in-ack' | 'send';
  dedupe: {
    key(event: unknown): string | null;
    ttlMs: number;
    onStoreUnavailable: 'proceed' | 'refuse';
    ack: 'after-write' | 'before-work';
  };
  secretRefs?(binding: Binding): string[];
}
```

Each platform fills it in from what its code does today:

| Member | Telegram | Slack |
|---|---|---|
| `bindingKey` | `config.chatId` | `config.teamId` and `config.chatId` |
| `isBindingHealthy` | the bot token is set in the environment | `teamId` and `botTokenRef` are set |
| `privateChatType` | `private` | `im` |
| `proveSender` | the chat is private | the sender is `config.slackUserId` |
| `commandReply` | `send` | `in-ack`, in the slash command's HTTP response |
| `dedupe` | 10 minutes; proceed if the store is down; ack after the write | 24 hours; refuse if the store is down; ack before the work |
| `secretRefs` | none (the token is in the environment) | `botTokenRef` and `pendingBind.botTokenRef` |

A Telegram private chat is between the bot and one person, so the chat being private is the sender proof. In a group, any member can write.

Every string a platform receives goes through that adapter's escape. The core hands an adapter fields, never markup. `render` is the one place an adapter turns those fields into the platform's text.

### Mapping errors to a `SendResult`

Today one module classifies both platforms' errors (`classifySlackDeliveryFailure`, `connectorDeliveryFailureService.ts:56`, and `classifyTelegramDeliveryFailure`, :79), and sorts the two by shape (:157). Under the contract, each adapter classifies its own errors and returns a `SendResult`. Each classifier moves into its adapter unchanged, and still decides `unreachable` on its own. Its reason becomes `unreachable.reason`, the text the user sees. The other three kinds sort what it returns null for.

| Result | Telegram | Slack |
|---|---|---|
| `unreachable` | 403 (blocked); 400 with "chat not found" | `channel_not_found`, `not_in_channel`, `is_archived` |
| `rejected` | any other 400; 401 | `invalid_auth`, `token_revoked`, `account_inactive`; `msg_too_long`, `invalid_blocks` |
| `throttled` | 429 | `ratelimited` |
| `ambiguous` | 5xx; HTTP 200 with `ok: false`; anything unclassified | `internal_error`; anything unclassified |

The `rejected` row keeps two exclusions the module already makes. Telegram's 401 and Slack's three credential errors belong to the shared bot app, not to one connector (comment at :27–33). A 400 that is not "chat not found" is about content, such as an unescaped entity, and not about whether the chat is reachable (:61–78).

The core logs every result that isn't `delivered`, once. Today the two bridges differ even here. Telegram returns quietly after noting the failure (tg :352–357). Slack throws (sl :268–273), which the dispatcher catches and logs (eventHandlers.ts:212–216).

## 4. Directions (D3)

A manifest declares its `directions` from a closed set, and its `transport` separately:

| Direction | Meaning | CI counts it as implemented when |
|---|---|---|
| `inbound` | platform content reaches a pod | the provider has `ingestEvent`, or a registered adapter has `parseInbound` |
| `publish` | a broadcast post: caption, hashtags, source URL | the provider has `publishPost` |
| `converse` | a line in a conversation, with replies routed back | an adapter is registered |
| `control` | platform commands that change the connector's own settings (ADR-025's third amendment) | the adapter's commands are wired to the core |
| `sync` | two-way state with an external system | never yet: it is reserved for ADR-027's phase 2, and no manifest may declare it |

`transport` says how bytes arrive: `webhook`, `gateway` or `polling`. Today's lists mix the two axes (`webhook` sits next to `summary`), which is one reason nothing can check them.

CI fails when a manifest declares a direction its code doesn't implement, or implements one it doesn't declare. ADR-025's Finding 2 table then becomes generated, as D3 asks (ADR-025:261–262).

This note maps two connectors. Telegram and Slack are `inbound`, `converse` and `control`, over `webhook`. Step 6 (§7) reads Discord, GroupMe, X and Instagram against their code. If one of them does something no direction names, step 6 stops and amends the vocabulary, rather than forcing a fit. A forced fit is the error the third amendment caught.

D3 asks for `capabilities[]` itself to be enumerated (ADR-025:258–262). This note adds `directions` and `transport` beside it instead. `capabilities` mixes the two axes, and its one reader (ChatRoom.tsx:1783) shows today's values, so it stays until that reader moves.

**Where the names are checked.** `ChannelVerdict`'s `provider` and `ruledVia` validate at save against the list of registered adapters. They reach it through a lazy require, which avoids a load cycle. The TypeScript unions (`'telegram' | 'slack'`) become `string`, narrowed by `isConverseType`.

**D4, in its cheapest form.** The `Integration` union (`models/Integration.ts:4–13`) and enum (:224–231) stay. A CI check holds them equal to the registry's types. D4 as written retires the enum for a validator over the registry (ADR-025:292–294). That would make the model load the registry, and the registry loads providers that load the model (`integrations/providers/slackProvider.ts:2`). The equality check gives D4's guarantee without the cycle: no stored type lacks a registered provider.

## 5. Drift

Six rules are spelled twice, and the two spellings differ. The core keeps one of each.

| # | Rule | Telegram | Slack | The core keeps | Step |
|---|---|---|---|---|---|
| 1 | The link | the plain line ends "open in Commonly" (tg :345–348) | the plain line has no link (sl :261–267), though the card has one (sl :91) | one link on every line, built once from one instance-URL source (TASK-285) | 3 |
| 2 | The pod tag | `podNameForTag` falls back to the pod's id, because "a lookup failure must not cost the relay" (tg :252–267) | reads the pod in one `Promise.all` with the token, so a failed lookup loses the line; a pod with no name is tagged `Commonly` (sl :252–256) | Telegram's rule | 3 |
| 3 | Commands | the full set (below) | `mode`, `mute`, `unmute`, `status` and help (`routes/webhooks/slack.ts:186–211`) | one set, one meaning per command, and one reply text each | 3 |
| 4 | Dedupe and ack | redelivers a failure that happened before the pod write | does not | the claim, run by the core; the timing, declared by the adapter | 2–3 |
| 5 | The relay-map key | writes `tgMessageId` only (tg :362, :366), and reads only it (tg :144) | writes `externalMessageId` (sl :279, :284), and reads either (sl :327) | `externalMessageId`, as the Slack plan promised | 5 |
| 6 | Eligibility | accepts a missing `type`, and `isActive !== false` | requires `isActive === true` | one predicate per question | 2 |

**Row 3, commands.** Telegram's set lives in `routes/webhooks/telegram.ts` (names at :35–46, dispatch at :480–512):

- `/commonly-enable` and `/commonly_enable`, which bind the chat (setup, out of scope);
- `/summary`, the legacy group summary, which buffers Telegram messages for a summary event (:223);
- `/pod_summary` and `/tldr`, an on-demand pod digest (:298);
- `/mode`, `/status`, `/mute`, `/unmute` and `/help`.

Slack has no `/tldr`, though the Slack plan listed it (slack-as-installable-connector.md:156–157). Slack's `status` says only "Relay is mirror" or "Relay is attention" (slack.ts:208–211). Telegram's names the pod, the mode, whether relay is on, the mute and the lead agent (telegram.ts:383–399). Both clamp `mute` with the same expression (telegram.ts:404, slack.ts:197).

The core owns `mode`, `mute`, `unmute`, `status`, `tldr` and help. `/pod_summary` stays as an alias of `/tldr`. `/summary` stays Telegram's legacy command, outside the contract.

**Who may run a command.** The two routes find the binding differently.

- Slack's lookup requires the bound user, a DM, a row not in error and no admin pause (slack.ts:161–170).
- Telegram's lookup reads only the chat id, `isActive` and the admin pause (telegram.ts:473–478). It checks no sender. ADR-025's third amendment filed this as #1287 (ADR-025:286–290).

The core runs `proveSender` before every command that writes the binding: `mode`, `mute` and `unmute`. Commands that only read (`status`, `tldr` and help) answer in the bound chat, as they do on both platforms today.

This brings one behaviour change, on Telegram: a command that writes needs a private chat. Every relay path already requires one: outbound (tg :189), inbound (tg :205, :454–461) and the reconciler (decisionCardReconcileService.ts:96–99). So on a group-bound row, those commands only wrote settings for a relay that cannot run there. That settles #1287 for writes. Reads in a group stay as they are (§9).

**Row 4, dedupe and ack.** Both platforms run the same claim against the same store, with different timing.

- **Telegram** (`routes/webhooks/telegram.ts`) claims an update for 10 minutes (:424, :441). It proceeds when the store is unavailable, and only a duplicate returns early (:444; comment :442–443). It relays before it acks, deliberately unwrapped (comment :521–527, call :530), and releases the claim on a throw (:549). So a failure before the pod write is redelivered.
- **Slack** (`routes/webhooks/slack.ts`) refuses a chat that isn't a DM before any database work (:128). It claims `${teamId}:${eventId}` for 24 hours (:135), and answers 503 when the store is unavailable (:142). It acks first, because Slack expects an answer within 3 seconds (:144–146), then works in `setImmediate` (:147). It releases the claim only if the relay hasn't started (:101, :110). So a failure before the pod write is not redelivered.

These are platform facts, so the adapter declares them and the core runs the one claim. Whether to retry Slack's lost failures ourselves is not decided here (§9).

**Row 5, the relay-map key.** The card-reply router reads either key (decisionCardReply.ts:50, :70). The reconciler replies with `tgMessageId` on Telegram (decisionCardReconcileService.ts:112) and `externalMessageId` on Slack (:127). The Slack plan said Telegram's writer would keep writing both keys until the map was migrated, and that readers would prefer the generic one (slack-as-installable-connector.md:150–153). Telegram's writer never did. Step 5 does it.

**Row 6, eligibility.** 11 places in 6 files decide whether a binding may relay:

- tg: `findLiveIntegration` (:154–178), `isRelayableIntegration` (:180–192) and `isInboundRelayableIntegration` (:197–208);
- sl: `isRelayableIntegration` (:62–73), `isInboundRelayableIntegration` (:119–130) and `findLiveIntegration` (:175–188);
- `routes/webhooks/slack.ts`: events (:85–94) and commands (:161–170);
- `routes/webhooks/telegram.ts`: commands (:473–478);
- the reconciler's `canSendClosingLine` (decisionCardReconcileService.ts:76–100);
- the dispatcher's selection (eventHandlers.ts:74–108).

They agree today only because of two defaults: `type` is required (`models/Integration.ts:226`), and `isActive` defaults to `true` (:453). Telegram's inbound check also ignores `status`. That is safe only because the flip that sets `status: 'error'` also unsets `config.chatId` (connectorDeliveryFailureService.ts:139–146), and the inbound check requires a chat id. A second writer of `status: 'error'` that kept the chat id would reopen inbound on a broken row. The lookups also fail differently: Telegram's fails closed and logs (tg :169–176), and Slack's has no catch.

The core has one predicate per question (may relay out, may relay in, may answer a command, may close a card), each written once beside its query form. A matrix test drives every predicate and its query form over the same rows (§8).

## 6. Invariants the core keeps

1. **Attribution (ADR-025 D15, :406–414).** An inbound post is authored as the binding's owner. #1289 gates inbound on a private chat, and #1297 gates outbound through `findLiveIntegration`'s `chatType: 'private'`. Both gates move into `eligibility.ts`, one per direction.
2. **Private chat, both ways.** No binding relays in either direction unless its chat is the adapter's `privateChatType`.
3. **Sender proof before writes.** No command that writes the binding runs before `proveSender` passes.
4. **The routed pod is re-checked.** A quote-reply's pod goes through `isRoutedPodTarget` at reply time. The relay map is data, not authority.
5. **Refused before selection.** The dispatcher refuses a post marked `noOutboundRelay` before it selects any binding (eventHandlers.ts:196). The core keeps that check first.
6. **No throw after the write.** Once an inbound message is in the pod, nothing after it may fail the request. Telegram's route relies on this to tell a repair from a duplicate (telegram.ts:521–527).
7. **Dedupe before the write.** The claim runs before any pod write, on every platform.
8. **Escaping.** Every string a platform receives goes through that adapter's escape.
9. **Verdicts, holds included.** A card a binding withholds still records its `hold` verdict (eventHandlers.ts:70–73).
10. **The flip.** A binding is flipped to `error` only on `unreachable`, and only for a send addressed to its own chat (connectorDeliveryFailureService.ts:177).

`noteBoundChatDeliveryFailure` is called from 12 sites in 5 files today. Ten are on the two-way path, in the two bridges and the reconciler. The other two are bind confirmations: Slack's "connected" line (`routes/installables.ts:519`) and Telegram's "Connected this chat" line (`routes/webhooks/telegram.ts:220`). After the migration, the two-way path has one flip, in the core. The two confirmations move onto `adapter.send` and the same flip, and the setup flows around them don't change.

## 7. Migration

Each step ships on its own and changes no behaviour except the drift rows it names.

| Step | What | Days |
|---|---|---|
| 1 | **Characterization tests.** Pin today's behaviour of both bridges, the reconciler and both routes, the six drift rows included, so each later step changes one row on purpose. | 1 |
| 2 | **The core and the Telegram adapter.** Move the flow into `core.ts` and the predicates into `eligibility.ts` (row 6). Telegram's adapter declares its dedupe timing (row 4). The bridge's exports become wrappers. | 2 |
| 3 | **The Slack adapter.** Settle rows 1–3: the link, the pod tag and commands, with `tldr` and the full `status` reaching Slack. Move the two bind confirmations onto `adapter.send`. | 2 |
| 4 | **Remove the literals.** The 16 lines in 7 files (§1) read the registered adapters instead. | 1 |
| 5 | **The relay-map key (row 5).** Telegram writes both keys. Readers prefer `externalMessageId`. Backfill `config.relayMap` and `config.cards` on existing rows, then stop writing `tgMessageId`. | 0.5 |
| 6 | **Directions and CI (§4).** Declare `directions` and `transport`, derive what's implemented from the code, and add the `Integration` equality check. Read the other four providers against their code, and stop to amend the vocabulary if one doesn't fit. | 1 |
| 7 | **A third adapter**, only when a team asks for one. | — |

That totals 7.5 implementor-days for steps 1–6.

## 8. Tests and acceptance

**Tests:**

- **A contract suite per adapter**, run against a fake platform client. It covers `render`, `send` and its `SendResult` mapping, `parseInbound`, `proveSender` and the dedupe declaration.
- **Escaping.** Hostile values in every field (pod name, author, text, card options), driven through every path that sends.
- **The eligibility matrix.** Each predicate and its query form, over the same rows, including a missing `type`, `isActive: false`, `status: 'error'` with and without a chat id, admin pause, mute, and a group chat.
- **A third adapter, registered inside the test at runtime.** It passes the contract suite, then does every round trip with no change outside the test file: an agent's post goes out through the dispatcher; a platform message comes in; a card is sent, answered by quote-reply, and closed by the reconciler.

**Acceptance.** A new chat connector consists of:

1. its adapter file;
2. its webhook route, which verifies the platform's signature;
3. its manifest entry;
4. its seed constant, plus an entry in the seed list (`scripts/seed-builtin-connectors.ts:111`);
5. three lines in `server.ts`: a require (like :31–33), a body parser (like :229–230), and a mount (like :270–272);
6. one registration line, beside `integrations/index.ts:63–68`;
7. its name in the `Integration` union and enum, which CI fails without.

Item 1 holds all of the connector's two-way logic. Item 2 holds the only other logic, the signature check, and items 3–7 are the five declarations. No logic branch on the two-way path names a platform, and the literal count (§10) falls from 16 lines in 7 files to 0.

Two lists in `routes/integrations.ts` still name types (:519, :842). They belong to setup, which is outside this contract (§9).

## 9. What this does not decide

- **ADR-025's (b) for Discord and GroupMe.** Whether they mirror is a product decision. This note makes it cheap to say yes, and doesn't say it.
- **ADR-027's phase 2.** It waits on its own trigger.
- **Hosted MCP.**
- **Identity in a group chat.** Inbound from a group needs a per-sender mapping from platform user to Commonly user, as a comment in the Telegram bridge says (tg :452–453). So does any command a group member runs. Read commands in a group answer as they do today. Whether a group may read a pod's digest is open.
- **Retries for Slack's lost failures.** Slack acks before the work, so a failure before the pod write is lost (§5, row 4). Whether to retry it from our side is open.
- **The external wire format, or an SDK for third-party adapters.** ADR-025 leaves the format open, and ADR-011 pauses driver-layer expansion.
- **Setup flows and the four off-path files** (§1).
- **ADR-025's D12 cold-start commands.** `/pods`, `/pod <name>` and the bare-message routing order aren't built. If they are, they join the core's command set and every adapter gets them.

## 10. How to re-measure

**The match.** Save as `remeasure.py`, then run `python3 -I remeasure.py backend/services/telegramBridgeService.ts backend/services/slackBridgeService.ts` from the repo root. At `36244e5a4` it prints:

```text
all code lines: telegram 466, slack 449, matching 276, 61% of slack, 59% of telegram
without short lines: telegram 368, slack 356, matching 197, 55% of slack, 54% of telegram
```

```python
import difflib, re, sys

PLATFORM = re.compile(r'telegram|slack|\btg\b|Tg(?=[A-Z])|\bsl\b', re.I)

def code_lines(path):
    out, in_block = [], False
    for line in open(path):
        s = line.strip()
        if in_block:
            in_block = '*/' not in s
            continue
        if s.startswith('/*'):
            in_block = '*/' not in s
            continue
        if not s or s.startswith('//') or s.startswith('*'):
            continue
        out.append(re.sub(r'\s+', ' ', PLATFORM.sub('X', s)))
    return out

def matching(a, b):
    blocks = difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks()
    return sum(block.size for block in blocks)

def report(label, tg, sl):
    same = matching(tg, sl)
    print(f'{label}: telegram {len(tg)}, slack {len(sl)}, matching {same}, '
          f'{100 * same / len(sl):.0f}% of slack, {100 * same / len(tg):.0f}% of telegram')

tg, sl = code_lines(sys.argv[1]), code_lines(sys.argv[2])
report('all code lines', tg, sl)
short = lambda s: len(re.sub(r'[\s{}()\[\];,]', '', s)) < 8
report('without short lines', [s for s in tg if not short(s)], [s for s in sl if not short(s)])
```

**The literal count.** From the repo root, this lists the 14 files that name both platforms:

```sh
for f in $(git grep -lE "'telegram'" -- 'backend/**/*.ts' 'backend/**/*.js' ':!backend/__tests__/**' ':!backend/scripts/**'); do
  grep -q "'slack'" "$f" && echo "$f"
done
```

The loop exits 1, because its last `grep -q` finds nothing. That is harmless. Within the 7 on-path files of §1, `grep -nE "'telegram'|'slack'"` gives the 16 lines.
