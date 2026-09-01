# ADR-025 — The connector substrate: outbound exists, synchronisation does not

**Status:** **Draft** — audit re-derived after sprint-review falsified the first version's
headline; the decisions below are proposals for Sam. Nothing here is ratified, and D1–D7 should
not be cited as settled. The landscape section is
deliberately unfilled pending cl-strategist's comparison memo (TASK-078); the current-state audit
and the shape proposal do not depend on it, so they are written now rather than held.
**Date:** 2026-08-26
**Author:** pod-architect (Lily Shen)
**Companions:** [`ADR-001`](ADR-001-installable-taxonomy.md) (the Installable model this should
become a component of), [`ADR-004`](ADR-004-commonly-agent-protocol.md) (CAP — the driver-facing
verbs), [`ADR-006`](ADR-006-webhook-sdk-and-self-serve-install.md) (the webhook driver, which is
the closest existing thing to a connector)

**Scope boundary — read this before reaching for ADR-007.** [`ADR-007`](ADR-007-ecosystem-integration-strategy.md)
is also called an "integration strategy" and is the document people will find first. It is about a
different subject: agent *SDKs* (OpenAI Agents SDK, Vercel Open Agents) and how an agent built
elsewhere reaches Commonly. This ADR is about *platform connectors* — Discord, Slack, Telegram,
GroupMe, and the enterprise systems that follow — and how a conversation on one side reaches the
other. They do not overlap and neither supersedes the other. ADR-007 is at Draft; so is this.

---

## Context

Sam's framing: *"we already support partial two-way."* The audit below is an attempt to say
precisely which part.

**Correction, and it is the reason to trust the rest of this section.** The first version of this
ADR claimed there was no outbound path at all. That was wrong, caught by sprint-review, and wrong
for a reason worth recording: I searched for a negative with a grep that required a send-verb and
an HTTP call on the same source line, which found two outbound calls out of ten — and I never
opened `backend/integrations/`, where the provider registry, the per-provider manifests, and the
`packages/integration-sdk` package live. A conjunctive same-line filter is not a search for a
negative, and a directory you did not open cannot be reported as absent. What follows was
re-derived by enumerating every outbound HTTP call in the connector code and every method each
provider actually implements.

Everything below was read at `origin/main` (`1a29a177`).

### Finding 1 — outbound exists in three modes, and none of them is event-driven

There are ten outbound HTTP calls in the connector code (`services/{discord,slack,telegram,groupme}*`
plus `integrations/providers/*`). They fall into three distinct trigger modes:

1. **Request-scoped replies.** `services/telegramService.ts`'s single `sendMessage` has fourteen
   call sites, all inside `routes/webhooks/telegram.ts` — the only file in the backend that
   references it. `services/discordService.ts:1116` and `:1187` are both Discord *interaction*
   endpoints, valid only within a live interaction token. These are answers to something that
   just arrived.
2. **Owner-triggered manual send.** `routes/integrations.ts:347` (`POST /:id/send`, human JWT,
   and gated to `pod.createdBy` alone) calls `DiscordService.sendMessage`
   (`services/discordService.ts:401`), which POSTs to a *stored* channel `webhookUrl` — a durable
   credential, not an interaction token. This is a real outbound path and the first draft of this
   ADR missed it.
3. **Agent-originated publish.** `routes/agentsRuntime.ts:3354` resolves a provider from the
   registry and calls `provider.publishPost(...)`, under a daily cap
   (`INTEGRATION_PUBLISH_DAILY_LIMIT`) with per-agent attribution written back to
   `config.lastAgentPublishBy`. Agents can and do originate outbound posts.

**What is uniformly absent is mode 4: a Commonly-side *event* originating an outbound call.** A
pod message, a reaction, or a task moving on the board reaches nothing. Every path above is
triggered by an inbound request, a human pressing a button, or an agent explicitly deciding to
publish. Nothing mirrors.

> **Amendment, 2026-08-26 20:40Z — mode 4 now exists, for exactly one connector.** The sentence
> above was true when this audit was re-derived and was falsified about thirty minutes later by
> [#1282](https://github.com/Team-Commonly/commonly/pull/1282), merged at `7a781821`. It adds
> `services/telegramBridgeService.ts` with both halves of a mirror: outbound,
> `relayAgentMessageToTelegram` is called fire-and-forget from
> `AgentMessageService.postMessage` (`services/agentMessageService.ts:1694`) on every agent post,
> gated at the far end by `shouldEscalate` and by an integration carrying `config.liveRelay`;
> inbound, `relayTelegramMessageToPod` writes the Telegram message into the pod as a real message
> so mentions fire and agents wake. A pod message now does reach something.
>
> Three consequences for the decisions below, none of which I think reverses one:
>
> - **D1's *naming* holds and its *inventory* does not.** "Do not claim two-way sync until mode 4
>   exists" now resolves differently per connector: telegram has it, the other three do not. The
>   claim to stop making is still the blanket one.
> - **It arrived outside the provider registry.** Finding 2's table stays literally true —
>   telegram still has no `publishPost` — and becomes misleading, because the first event-driven
>   outbound path in the codebase does not use the registry at all. It is a direct service call.
>   That is evidence for D2's shape argument rather than against it: when the registry's verb set
>   did not fit, the implementation went around it.
> - **The loop, permission and volume risks D7 defers are now live** on one connector rather than
>   hypothetical. `shouldEscalate` plus `liveRelay` defaulting to `false` are the whole bound.
> - **Second amendment, 2026-08-26 — the bound moved in both directions, and the line above was
>   written between the two moves.** When it was written, `liveRelay` had no named writer anywhere:
>   the flag defaulted to `false` and nothing in the product could set it, so "the whole bound" was
>   really "nobody can turn it on". Two merges changed that. **#1290** (`e35d89e6`) ships the
>   Connectors page whose Live-relay toggle is the first real writer — `V2ConnectorsPage.tsx:117` at the time
>   PATCHes `{liveRelay}` (that file has since been rewritten — see the fourth amendment), and `integrations.ts:406` stamps `linkedUserId` from the authenticated
>   caller when it flips on — so mode 4 is now reachable by an ordinary user path rather than only
>   in principle. **#1289** (`f9b97d89`) narrows the inbound half to 1:1 chats:
>   `telegramBridgeService.ts:213` refuses to relay unless `config.chatType === 'private'`, because
>   every inbound message is authored as `config.linkedUserId`, and a private chat at least narrows
>   the sender to a single person. It does not establish that the person is the linked user, and
>   nothing in the code does: `handleEnableCommand` captures no user identity when the chat is
>   bound, while `linkedUserId` is stamped by whoever later PATCHes `liveRelay` on. So the loop,
>   permission and volume risks D7 defers are live on a connector a user can now actually switch
>   on, and the permission one is NOT bounded — the invariant it would need is a link between the
>   chat's counterpart and the toggling caller, and that link does not exist. **D1's naming decision is unaffected — this changes what the inventory
>   says exists, not what it should be called.**
> - **Third amendment, 2026-08-27 — the default flipped, so "defaults to `false`" above is no
>   longer true of telegram.** #1311 (`3eaabfc8`) sets `relayAllAgentMessages: true` and
>   `liveRelay: true` on a fresh telegram connector when the caller sends neither
>   (`routes/integrations.ts`, the `type === 'telegram' && nextConfig.relayAllAgentMessages ===
>   undefined` block). `V2ConnectorsPage.tsx:131` creates with `config: {}`, so this is the primary
>   product path and not an edge case. Its reason is sound — attention mode with no
>   `leadAgentUsername` relays nothing, so the bridge's first impression was silence. The
>   consequence for this Finding is that **both** levers of the bound named above are now ON at
>   create: `relayAllAgentMessages` is `shouldEscalate`'s first branch
>   (`telegramBridgeService.ts:71`), so the escalation gate is not merely mutable, it is open by
>   default. The bound is now the chat binding itself.
>
>   That matters because the OUTBOUND half has no chat-type gate — #1289's `chatType !== 'private'`
>   refusal is at `:216`, inside `relayTelegramMessageToPod`, i.e. inbound only. So on `origin/main`
>   a connect code pasted into a group mirrors the pod's whole agent stream into that group with
>   nobody having toggled anything. **#1297 (open) refuses that bind**, and #1311 is what makes its
>   gate load-bearing: `if (integration.config?.liveRelay && chatType !== 'private')` short-circuits
>   on a falsy first operand, which is what a fresh connector used to have. The same line went from
>   covering an edge case to covering the default path without being edited. Filed at #1297 comment
>   `5458773871`.
>
> - **Fourth amendment, 2026-08-27 — the mode lever came back to the web, and the line reference
>   above went stale in the same merge.** #1304 (`6ce4bfc8`, "Connectors page redesign") rewrote
>   `V2ConnectorsPage.tsx` (+358/-154), so the `:117` cited above no longer exists: the Live-relay
>   PATCH is now `:233`, and the `config: {}` create is still `:131`. The substantive change is a
>   **second writer of `config.relayAllAgentMessages`** — an Attention/Mirror toggle at `:243` and
>   `:251` PATCHing the same key the Telegram `/mode` command writes. That key appears nowhere in
>   the file before #1304. The two writers are gated asymmetrically: the web toggle renders only
>   when `config.liveRelay` is true (`:237`), while `handleModeCommand`
>   (`routes/webhooks/telegram.ts:256`) writes it whether or not the relay is on. **D1's naming
>   decision is unaffected.**
>
> I have not re-derived the ten-call inventory at the top of this finding against current main.
> The amendment covers what #1282, #1289 and #1290 changed, and nothing else — #1301 moved this
> same bound again and is recorded in D3's third amendment rather than here, because what it adds
> is a new *direction* and not a new outbound path.

So "partial two-way" is accurate, and the precise missing piece is narrower and more interesting
than "outbound": it is **synchronisation**.

### Finding 2 — the registry's only outbound verb is `publishPost`, and no chat provider has it

`backend/integrations/` already contains the abstraction ADR-001 would ask for: a provider
registry (`integrations/index.ts`, backed by `packages/integration-sdk/src/registry.js`), and
per-provider manifests carrying `requiredConfig`, a generated `configSchema`, and a declared
`capabilities` list (`integrations/manifests.ts`).

Enumerating what each of the six providers actually implements:

| provider | validateConfig | ingestEvent | syncRecent | health | publishPost |
|---|---|---|---|---|---|
| discord | ✓ | ✓ | ✓ | ✓ | — |
| slack | ✓ | ✓ | ✓ | ✓ | — |
| telegram | ✓ | ✓ | ✓ | ✓ | — |
| groupme | ✓ | ✓ | ✓ | ✓ | — |
| x | ✓ | ✓ | ✓ | ✓ | **✓** |
| instagram | ✓ | ✓ | ✓ | ✓ | **✓** |

Four of the five verbs are inbound or health. The one outbound verb, `publishPost`, is implemented
by exactly the two *social broadcast* providers and by none of the four *chat* providers. The SDK's
shared types (`packages/integration-sdk/src/types.js`) are `NormalizedMessage` and
`NormalizedSummaryInput` — both inbound shapes; there is no normalized outbound message at all.

**This is the enterprise finding.** Discord's outbound send exists (Finding 1, mode 2) but lives
*outside* the registry, in a service method reachable from one legacy owner-only route. It never
became a provider verb, so nothing else in the system can reach it and no other chat provider had
a shape to copy. Slack's send is literally `return res.json({ success: true, result: 'not-implemented' })`
at `routes/integrations.ts:360`. The connectors an enterprise actually buys — Slack, Teams-shaped,
Discord — are the ones with no conversational outbound in the abstraction.

### Finding 3 — the provider enum and the registry disagree about what a connector is

`models/Integration.ts:96-101` types a connector as a closed enum of eight strings, and
`routes/agentsRuntime.ts:3193` dispatches on it with an `if / else if` chain that does its own
per-provider credential check and its own `require()`. Meanwhile `integrations/index.ts` resolves
providers from a registry keyed by the same string.

Both mechanisms are live, in the same file in at least one case. So a connector is *simultaneously*
a registry entry and a schema literal, and the enum contains entries (`messenger`, `whatsapp`) with
no provider registered at all — the enum is a wish list and a dispatch key at once, and nothing
distinguishes "declared" from "implemented."

The first draft called this "a schema enum, not an installable." That was too strong: the registry
exists and is good. The accurate defect is the **duplication** — two sources of truth for the same
question, one of which cannot be extended without a schema migration.

### Finding 4 — `config` is a union of every provider's fields

`models/Integration.ts:108-161` is one flat sub-document holding roughly forty keys drawn from all
eight providers at once. Note this coexists with the manifests' per-provider `configSchema`: the
schema knows Slack needs `botToken`, `signingSecret`, `channelId`, but the storage model accepts
any of the forty for any provider. The validation exists and the persistence layer does not enforce it.

`config.messageBuffer` also lives here: an inline array of up to `maxBufferSize` (default **1000**)
messages inside the configuration document, so config and message data share one record and one
lifecycle.

### Finding 5 — connector credentials are at rest in plaintext

`botToken`, `signingSecret`, `secretToken`, `accessToken`, and `refreshToken` are declared as bare
`String` (`models/Integration.ts:115-127`), with no getter/setter, no `select: false`, and no
encryption layer anywhere — grepping the whole of `backend/` (excluding `node_modules` and tests)
for `encrypt`/`decrypt`/`createCipher` returns zero files.

This is the largest enterprise blocker in the audit. It is a design gap in how we store third-party
credentials, not a known exploit, and it is the kind of thing any enterprise security review reaches
in its first hour.

### Finding 6 — a connector binds to exactly one pod

`models/Integration.ts:95`: `podId` is required and singular. An organisation wanting one Slack
workspace reflected across twenty pods needs twenty documents and twenty copies of one credential
to rotate. ADR-001 solved this shape for Installables — one source-of-truth record projecting to N
runtime rows — and connectors did not inherit it.

---

## Landscape

**Deliberately empty.** cl-strategist owns TASK-078: a comparison of how tutti, open-agents,
cumora, grok bot, and bloome handle connect / auth / two-way sync / permissions / enterprise
controls, from public documentation and observable behaviour only. When that memo lands, this
section carries it and D2–D4 get re-derived against it.

Writing a competitive section from memory here would be the failure this ADR is otherwise trying
to name: a confident claim with no reader behind it.

---

## Proposed decisions

**D1 — Name the gap as synchronisation, not as outbound.** Outbound exists in three trigger modes
and agents already publish through it. What does not exist, for three of the four connectors, is
any path from a Commonly-side event to a connector; telegram gained one in #1282 — see the
amendment to Finding 1, which is the reason this sentence is no longer blanket. Product surfaces
should claim *publishing* and *ingestion*, and should not claim two-way *sync* for any connector
that lacks mode 4, which today means every connector except telegram. This is the decision I
most want ratified, because the first draft of this ADR got it wrong in the other direction and
an imprecise headline is what produced that error.

**D2 — Add a conversational outbound verb to the provider contract.** The registry has exactly one
outbound verb and it is `publishPost`, a broadcast shape (caption, hashtags, source URL) that four
of six providers do not implement. Enterprise chat needs `sendMessage(threadRef, content)` as a
first-class provider method, with `NormalizedOutboundMessage` alongside the SDK's existing
`NormalizedMessage`. Discord's existing send is the reference implementation to lift into the
registry — additive, per design rule 2, leaving `POST /:id/send` working while it migrates.

**D3 — A provider declares its directions, and the manifest is the place.** `capabilities[]` already
exists in every manifest and is currently free-form prose (`['webhook', 'gateway', 'summary',
'commands']`). Make it enumerated and enforced, so `inbound` / `publish` / `converse` / `sync` are
checkable in CI rather than inferred from which methods happen to be defined. Finding 2's table
should be generated, not hand-written.

> **Third amendment, 2026-08-27 — D3's four-value enum would drop a direction that shipped
> tonight.** #1301 (`97b6a870`) adds a Telegram *control plane*: `/mode mirror|attention`,
> `/mute [minutes]`, `/unmute`, `/status`, `/tldr`, `/help`, handled in `routes/webhooks/telegram.ts`.
> These are not inbound content and not outbound publication — they are commands from the platform
> that **mutate the connector's own configuration**. `/mode` is the first named writer of
> `config.relayAllAgentMessages`, and `/mute` introduces `config.relayMutedUntil`; both were among
> the keys this ADR's audit found unwritten.
>
> That is a fifth direction, and the enum proposed above cannot name it. Note that the free-form
> `capabilities[]` value D3 quotes as the thing to replace — `['webhook', 'gateway', 'summary',
> 'commands']` — **already carries `commands`**. Enumerating to `inbound / publish / converse / sync`
> as written would delete a name the codebase already uses for a surface that now has an
> implementation. D3's decision stands; its vocabulary needs a fifth member (`control`, or whatever
> it ends up called) before it is ratified, or the enforcement it asks for lands narrower than the
> product.
>
> It is also the **second** instance of Finding 2's pattern, which is why it belongs here rather than
> in a bug report. The first event-driven outbound path (#1282) went around the provider registry;
> so does this control plane. Twice now, when the registry's verb set did not fit, the implementation
> did not extend the registry — it added a route. A capability vocabulary that is enforced in CI is
> only worth having if the paths that grow capabilities are the ones it governs.
>
> One consequence sits outside this ADR and is filed at issue #1287 rather than decided here: the
> command handlers resolve their integration by `config.chatId` alone, reading neither
> `message.from.id` nor `config.chatType`, so in a linked group chat any member can flip the relay
> mode or mute the operator's escalations. D7's enterprise-scoping decision inherits that question —
> a connector projected to N pods needs to say who may reconfigure it, and today nothing does.

**D4 — Retire the enum in favour of the registry.** Finding 3's defect is duplication, not the
absence of an abstraction. The registry wins; `models/Integration.ts`'s enum becomes a soft
reference validated against registered providers, and the `if/else` chains become registry lookups.
This removes the "declared but unimplemented" state the enum currently permits.

**D5 — Enforce the manifest's `configSchema` at the persistence boundary.** Per-provider validation
already exists and the storage model ignores it. Validating on write turns a class of call-time
400s into save-time errors, and costs no new design.

**D6 — Credentials move behind a secret reference before any new connector ships.** The
`Integration` document stores a reference, not the material. Whether that is ESO-backed, a KMS
envelope, or application-level encryption is an implementation call I am not making here — but
shipping a seventh plaintext credential is a decision too, and it should be taken deliberately.

**D7 — Connectors scope like Installables.** One connector record projected to N pods, per ADR-001's
one-install-fans-out, so an enterprise install is one administrative act rather than twenty.

> **Superseded for the private-chat case — the reconciliation position (pod-architect, 2026-09-01).**
> Sam's 2026-08-31 01:44Z ruling folds #1295 into this document and delegates "whose text is
> canonical" to cl-strategist and me. This is my half of that call, filed as an artifact rather than
> a comment so it carries its own answer.
>
> The two texts overlap on exactly one decision. #1295's **"The private chat binds to the USER, not
> to a pod"** — `Integration.scope: 'user'`, `linkedUserId` the owner, no `podId` — **replaces D7**
> for that case, and lands as the first folded decision (D8 under the D8+ numbering, so no slot is
> contested). D7's own evidence is what argues for it: Finding 6 measures `podId` as required and
> singular, and reads that as an N-pod projection problem, because a projection is what ADR-001
> supplies. But an enterprise install and a person's private chat want opposite things from the same
> field. A projection to N pods keeps the pod as the binding unit and multiplies it; the user-scoped
> record removes the binding unit instead, which is the shape a private chat actually has — one
> human, every pod they are in, one credential. Finding 6 stays as written; only the decision it
> feeds changes.
>
> D7 is **not** withdrawn: team-group bridging still wants one record across many pods, and #1295
> keeps the pod-scoped connector for exactly that, dormant until per-sender attribution exists. So
> the two are a case split, not a contest — D7 for the shared channel, the folded D8 for the private
> one. Read D7 as scoped to team-group bridging from here.

---

## What this ADR does not decide

- **The wire format for D2's conversational verb.** Whether it reuses CAP's shapes, the webhook
  driver's payload, or something new is open, and the landscape memo should inform it.
- **Whether federation counts as a connector.** `services/federationService.ts` and
  `routes/federation.ts` exist and may belong to this substrate or may be a separate axis. Not
  investigated; naming it here so its absence is a gap rather than an oversight.
- **Retention of `config.messageBuffer`.** Finding 4 says it should not live in the config
  document; it does not say where it goes.
- **Whether mode 4 (event-driven mirroring) should exist at all.** D1 says stop claiming it; it
  does not say build it. Mirroring carries loop, permission, and volume questions none of the
  current connectors answer, and that is a product decision. Note that #1282 has since answered it
  de facto for telegram, by shipping it — which makes the question sharper, not moot: whether the
  other three follow, and whether the shape #1282 chose is the one they should copy, is still open
  and is still a product decision rather than an inference from one merge.
- **Anything requiring the landscape.** D2's payload shape, D3's capability vocabulary, and the
  enterprise-controls surface (audit log, per-channel permissions, data residency) are all
  under-specified on purpose until TASK-078 lands. One gap in D3's vocabulary is now known
  independently of the landscape and is recorded in its third amendment — the control direction —
  so that much can be settled without waiting.

---

## Open question for Sam

The honest headline is *"we can publish, and we cannot mirror."* Agents already post to X and
Instagram through a rate-limited, attributed endpoint; no chat connector has a conversational
outbound verb, and — as of the amendment in Finding 1 — exactly one connector is driven by a
Commonly-side event, through a path that bypasses the registry. The headline holds for three of
the four chat connectors and no longer holds for telegram.

So the redesign is not "build outbound" — it is (a) give the four chat providers the verb the two
social providers already have, and (b) decide whether mirroring is a product commitment at all,
because mode 4 is a much larger build than modes 1–3 and carries loop, permission, and volume
questions modes 1–3 never had to answer — questions #1282 now has to answer for telegram. The
bound WAS `shouldEscalate` plus `liveRelay`, and since #1311 (`3eaabfc8`) neither half of it
defaults to `false` on telegram — a fresh connector is created with `relayAllAgentMessages` and
`liveRelay` both true, on the path the Connectors page actually uses. Before that: since #1290 a
user can turn that flag on from the Connectors page, and since #1289 the inbound half refuses any chat that is
not 1:1. See Finding 1's second and third amendments — a default is only a bound while
nothing can change it, something can now, and on telegram the default itself has since flipped the
other way. Since #1301 the bound has a third mutator and it is reachable
from the platform side: `/mode mirror` sets `config.relayAllAgentMessages`, which is
`shouldEscalate`'s first branch — so a Telegram command turns the escalation gate off entirely, and
`/mute` suspends the relay from the same surface. That direction did not hold. Since #1304 (`6ce4bfc8`) the mode lever has a second writer on the
web side — an Attention/Mirror toggle in the Connectors page PATCHing the same key — so the
levers are not migrating into the chat; two surfaces now write one flag, on asymmetric gates.
See Finding 1's fourth amendment.

D1 is the one I want ratified. The rest follow from the audit.
