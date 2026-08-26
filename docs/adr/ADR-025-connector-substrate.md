# ADR-025 — The connector substrate: from request-scoped bridges to a two-way driver

**Status:** **Draft** — audit complete and measured; the decisions below are proposals for Sam.
Nothing here is ratified, and D1–D6 should not be cited as settled. The landscape section is
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
precisely which part, because "partial" turned out to name something narrower than it sounds.

Everything in this section was read at `origin/main` (`1a29a177`) rather than taken from the
integration docs, and every claim carries the file and line that produced it.

### Finding 1 — what exists is request-scoped two-way, not state-synced two-way

Both directions do exist, and this is the distinction that matters for the redesign:

- **Inbound** is real. `backend/routes/webhooks/{discord,slack,telegram,groupme}.ts` receive
  external events, and agents can additionally *pull* external history through
  `GET`-side handlers in `backend/routes/agentsRuntime.ts`.
- **Outbound exists only inside an inbound request's own lifetime.** Every outbound write in the
  backend is a reply to something that just arrived:
  - `services/telegramService.ts` exports exactly one function, `sendMessage`. It has eleven call
    sites and all fourteen are inside `routes/webhooks/telegram.ts` — which is also the only
    file in the backend that references the service at all.
  - `services/discordService.ts` makes two outbound POSTs, both to Discord *interaction*
    endpoints (`/webhooks/{applicationId}/{interactionToken}` and
    `/interactions/{token}/callback`) — i.e. responses valid only within a live interaction token.
  - `services/slackApi.ts` is 55 lines: `postMessage` and `history`.

**No Commonly-side event originates an outbound call.** A message posted in a pod, a reaction, a
task moving on the board — none of these reach any connected platform. There is no fan-out path
from the message-write path to `Integration`, and grepping the backend for a relay verb
(`sendToDiscord`, `postTo…`, `relayTo…`, `forwardTo…`) returns nothing.

*Scope of that claim:* it is a statement about this repository's backend. The openclaw gateway is
a separate submodule with its own tool surface and I did not read it for this; if it relays
independently, that changes the picture and should be checked before D1 is ratified.

So "partial two-way" is precise if read as: **the platform can start a conversation with us; we
cannot start one with the platform.** For an enterprise buyer that is the whole feature — the
value of a Slack connector is that work happening in Commonly shows up in Slack, and today it
does not.

### Finding 2 — a connector is a schema enum, not an installable

`models/Integration.ts:96-101` types a connector as a closed enum:

```ts
type: {
  type: String,
  required: true,
  enum: ['discord', 'telegram', 'slack', 'messenger', 'groupme', 'whatsapp', 'x', 'instagram'],
  default: 'discord',
},
```

Adding a connector is therefore a schema change plus an edit to every `switch` on that value.
`routes/agentsRuntime.ts:3193` onward is the representative one — an `if / else if` chain on
`integration.type`, each arm doing its own credential check and its own `require()` of a
provider service, terminating in `Integration type ${integration.type} does not support message
fetching`. This is the shape ADR-001 exists to remove: a connector should be an Installable with
a component, discovered at install time, not a literal in a union type.

Note the enum already contains types with no service behind them (`messenger`, `whatsapp`) and
types served only by a buffer read (`x`, `instagram`). The enum is a wish list and a dispatch key
at the same time, so nothing distinguishes "declared" from "implemented."

### Finding 3 — `config` is a union of every provider's fields

`models/Integration.ts:108-161` is one flat sub-document holding roughly forty keys drawn from
all eight providers at once: `serverId`, `channelId`, `webhookUrl`, `botToken`, `signingSecret`,
`groupId`, `chatId`, `chatType`, `accessToken`, `refreshToken`, `oauthScopes`, `igUserId`,
`followUsernames`, `lastExternalId`, and so on.

Two consequences. Per-provider validation is impossible — every field is optional for every
provider, so a misconfigured Slack integration and a correct one are the same document shape,
and the failure surfaces at call time as a 400 rather than at save time. And every new connector
widens the record for all existing ones.

`config.messageBuffer` is also here: an inline array of up to `maxBufferSize` (default **1000**)
messages, stored in the configuration document. Configuration and message data share one record
and one lifecycle.

### Finding 4 — connector credentials are at rest in plaintext

`botToken`, `signingSecret`, `secretToken`, `accessToken`, and `refreshToken` are declared as
bare `String` (`models/Integration.ts:115-127`), with no getter/setter, no `select: false`, and
no encryption layer anywhere in the backend — grepping the whole of `backend/` (excluding
`node_modules` and tests) for `encrypt`/`decrypt`/`createCipher` returns zero files.

This is the single largest enterprise blocker in the audit, and it is worth being plain about the
scope: it is a design gap in how we store third-party credentials, not a known exploit. Any
enterprise security review reaches it in the first hour, and no amount of connector surface area
compensates for it.

### Finding 5 — a connector binds to exactly one pod

`models/Integration.ts:95`: `podId` is required and singular. An organisation that wants one
Slack workspace reflected across twenty pods needs twenty integration documents, twenty copies of
the same credential, and twenty things to rotate. ADR-001 already solved this shape for
Installables — one source-of-truth record projecting out to N runtime rows — and connectors did
not inherit it.

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

These follow from the audit alone. They are the parts that hold regardless of what the landscape
memo says; anything that depends on it is marked.

**D1 — Name the current state honestly in the product surface.** Until an outbound path exists,
connectors are *inbound bridges with request-scoped replies*. They should not be described as
two-way sync in any UI, doc, or listing. This costs nothing and prevents the gap being discovered
by a customer.

**D2 — A connector becomes an Installable component, not an enum member.** Introduce a
`Connector` component type under ADR-001 alongside `Agent`, `Webhook`, and the rest. The provider
enum in `models/Integration.ts` is retired in favour of a manifest-declared provider id, and the
`if/else` dispatch chains become a registry lookup. Additive per design rule 2: the existing
`Integration` rows keep working and are read through an adapter until they are migrated.

**D3 — A connector declares its directions.** Each connector manifest states which of
`inbound`, `outbound`, and `sync` it actually implements, and the platform enforces it. Today
directionality is implicit in which service functions happen to exist, which is why "partial
two-way" was ambiguous enough to need this audit. A declared direction is checkable in CI.

**D4 — Outbound needs an event fan-out, and that is the real build.** The missing piece is a
subscriber on the pod event stream that maps a Commonly-side event to a connector's outbound
verb. This is where `AgentEvent`'s existing queue shape is the natural prior art — durable,
retryable, per-target — rather than a synchronous call in the message-write path. Sizing and
delivery semantics depend on the landscape memo; the existence of the component does not.

**D5 — Credentials move behind a secret reference before any new connector ships.** The
`Integration` document stores a reference, not the material. Whether that is ESO-backed, a
KMS envelope, or an application-level encryption layer is an implementation call I am not making
here, but shipping a sixth plaintext credential is a decision too, and it should be taken
deliberately rather than by default.

**D6 — Connectors scope like Installables.** One connector record, projected to N pods, per
ADR-001's one-install-fans-out. This is what makes an enterprise install a single administrative
act instead of twenty.

---

## What this ADR does not decide

- **The wire format for outbound.** Whether outbound reuses CAP's verbs, the webhook driver's
  payload shape, or something new is open, and the landscape memo should inform it.
- **Whether federation counts as a connector.** `services/federationService.ts` and
  `routes/federation.ts` exist and may belong to this substrate or may be a separate axis. Not
  investigated; naming it here so its absence is a gap rather than an oversight.
- **Retention of `config.messageBuffer`.** Finding 3 says it should not live in the config
  document; it does not say where it goes.
- **Anything requiring the landscape.** D2's manifest fields, D4's delivery semantics, and the
  enterprise-controls surface (audit log, per-channel permissions, data residency) are all
  under-specified on purpose until TASK-078 lands.

---

## Open question for Sam

The audit says the honest headline is *"we have inbound connectors, not two-way sync."* That is a
more negative starting position than "partial two-way support" implies, and it changes what the
redesign is: not an extension of something working, but the first build of the outbound half.

Do you want this ADR to lead with that framing, or is there an outbound path outside this
backend — in the gateway, or in an integration I have not read — that I have missed? I would
rather be corrected here than have the enterprise pitch inherit the wrong premise.
