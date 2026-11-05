# External Integration Contract (current + planned)

> Goal: make every external chat integration (Discord, WhatsApp, Telegram, Slack, etc.) plug‑and‑play, testable, and contributor‑friendly for open source.

## Principles
- **Single lifecycle**: connect → verify → ingest → summarize → post.
- **Small surface**: minimal required methods; shared helpers for the rest.
- **Deterministic tests**: contract tests ensure any provider meets the same guarantees.
- **Security first**: signature/verify-token checks required; clear error paths.

## Provider interface (proposed)
Create one provider per platform implementing these methods:

- `validateConfig(config)` → `Promise<void | Error>`
  - Ensures required fields (tokens/IDs/URLs) are present and well‑formed.
- `getWebhookHandlers()` → `{ verify: (req,res), events: (req,res) }`
  - `verify` handles GET challenge (e.g., WhatsApp `hub.challenge`, Discord ping).
  - `events` handles POST event/webhook delivery, returns 200/204 after enqueue.
- `ingestEvent(payload)` → `Promise<NormalizedMessage[]>`
  - Parse provider payload into normalized messages (see schema below).
- `syncRecent({ since })` → `Promise<NormalizedMessage[]>`
  - Pull recent history via provider REST API for scheduled/manual syncs.
  - Poll-only providers (X/Instagram) may implement only `syncRecent` + `health`, with empty webhook handlers.
- `health()` → `Promise<{ ok: boolean, details?: any }>`
  - Lightweight check (token validity, minimal API call, or cached status).
- `register?()` (optional) → `Promise<void>`
  - For providers needing command/endpoint registration (e.g., Discord slash commands).

## Normalized data shapes
- **NormalizedMessage**
  - `source`: `'discord' | 'whatsapp' | 'telegram' | 'slack' | ...'`
  - `externalId`: string (provider message ID)
  - `threadId?`: string
  - `authorId`: string
  - `authorName`: string
  - `content`: string
  - `timestamp`: ISO string
  - `attachments?`: `{ type: 'image'|'file'|'link', url: string, title?: string }[]`
  - `metadata?`: provider-specific small fields (e.g., channelId, chatId)

- **NormalizedSummaryInput**
  - `messages: NormalizedMessage[]`
  - `context: { source, channelId/chatId, window: { start, end } }`

## Runtime flow
1) **Configure**: `validateConfig` on save; store in `Integration.config`.
2) **Webhook verify**: provider `verify` responds to challenge/verify-token.
3) **Inbound events**: `events` → `ingestEvent` → enqueue messages into buffer.
4) **Sync job**: scheduler summarizes buffered messages; `syncRecent` is reserved for backfill or manual runs.
5) **Summarize**: feed normalized messages to summarizer; persist the result as pod memory (`PodAsset`) and enqueue an agent event for external runtimes (e.g., Commonly Bot) to post into pods.
6) **Health**: expose a provider-specific health route when the provider has
   one; the shared integration surface does not invent a universal health
   route for providers that do not implement it.

## Pod memory & agent context

Integration summaries are not just messages:
- Summaries should be persisted as indexed pod memory via `PodAsset` (for example `type='integration-summary'`).
- `GET /api/pods/:id/context` reads these pod assets to assemble agent-friendly context.
- In LLM skill mode, the pod context endpoint may synthesize markdown skills from recent summaries and assets, and store them as `PodAsset(type='skill')`.

## Operational note (public endpoints)
- Webhook and interactions endpoints must be publicly reachable. If you front them with Cloudflare Tunnel, ensure the hostname is added to tunnel **ingress** (DNS-only changes can still return Cloudflare 404s and fail provider verification).

## Registry & factory (backend)
- `integrationRegistry.register(type, providerFactory)`
- `const provider = integrationRegistry.get(integration.type, integration.config)`
- Keeps routing logic out of routes/controllers; enables easy extension.

## External provider services (planned)
For externalized providers, a standalone service receives platform webhooks and
forwards normalized events to the Commonly context layer. The platform serves
`POST /api/integrations/ingest`, which accepts `{ provider, integrationId,
event }` or normalized `messages` and appends them to the integration buffer
for summarization. Issue an `cm_int_*` ingest token through
`POST /api/integrations/:id/ingest-tokens`; send it as a Bearer token or
`x-commonly-integration-token`.

## Security requirements
- Webhook signature/verify-token checks mandatory; reject on mismatch.
- Rate-limit webhook routes; strip PII beyond what’s needed for summaries.
- Store secrets encrypted (reuse existing config patterns).

## Who may bind a pod to a chat (F143)
A chat that people outside the pod can read is a **shared surface**: a Slack
channel, a Discord guild channel, a Telegram group, supergroup or channel, and
a GroupMe group. Binding a pod to one takes authority over the pod: the pod's
creator (still a listed member) or an instance admin (`User.role === 'admin'`).
Pod membership is not enough. A **private 1:1** chat with the bot (a Telegram
`private` chat, the Slack OAuth DM) is read only by the person who bound it and
stays member-level.

The rule lives in one place, `backend/services/chatRelay/bindSurface.ts`. Each
platform declares there who can read its chat; an unknown type, or a chat type
not declared private, counts as shared. The server refuses with 403
`{ code: 'shared_surface_needs_pod_authority' }`, and the v2 pages map that code
to `connectors.sharedSurfaceCreatorOnly` (en and zh-CN).

It is checked at:
- **create**: `POST /api/integrations` (Slack, Discord, GroupMe; a non-string
  `type` is refused with 400 first), and Discord's
  `GET /api/discord/install-link/:podId`;
- **retarget**: `PATCH /api/integrations/:id`, when a field that picks the chat
  changes (Slack `channelId`, GroupMe `groupId`/`botId`; Discord's are fixed by
  F90), or when a user-scoped connector's `podId` moves;
- **redemption**: Telegram's `/commonly-enable`, because the chat type is only
  known there. It is judged against the row's `createdBy`, and a refused code is
  left unspent for a private chat;
- **outbound summaries**, judged against the row's `createdBy`: Telegram
  `/tldr` (`/pod_summary`), GroupMe `!pod`, and Discord `/commonly-summary`.
  Each posts the pod's latest summary to everyone in the chat.

Rows bound by plain members before the rule keep working. The only runtime
gates are the three outbound summary commands above, which answer with a short
refusal and no summary on such a row until the pod's creator reconnects it.

## Who a relayed line is written as (F131)
A live relay writes an external line into the pod **as `config.linkedUserId`**.
That is honest only when the platform proves the sender is that person, so each
platform declares its proof as an inbound adapter (`InboundRelayAdapter` in
`backend/services/chatRelay/chatRelayCore.ts`, registered in
`chatRelay/adapters.ts` as `inboundRelayAdapters`):
- **Telegram**: the chat is `private`, so the sender is its one counterpart.
- **Slack**: the DM's `event.user` is the `slackUserId` the OAuth bind proved.
- **Discord**: a guild channel proves nothing, so the author must be the
  installer's own Discord account. The install link asks for `identify`, the
  OAuth callback reads `users/@me` with the exchange's user token, the id rides
  in the signed install proof, and `POST /api/integrations` stores it as the
  server-owned `config.discordUserId`. A line relays live only when
  `author.id === discordUserId` and `linkedUserId` is the row's creator; every
  other line stays in the summary buffer. Bots, webhooks (our own echo) and
  system messages are ignored.

`writeInboundAsLinkedUser` and `loadInboundAuthor` take a `ProvenSender`, which
only `proveInboundSender` mints, after the adapter's proof passes. The same
adapter declares `liveRelayRefusal`, which both integration write routes read
before `liveRelay` goes on: the private-chat rule for Telegram and Slack (and
any undeclared type), the proven installer for Discord.

A platform that pushes one message to every backend replica (Discord's gateway
socket) claims it with `claimInboundMessage(provider, integrationId, messageId)`
before writing; that is the WebhookDelivery unique index the HTTP bridges'
redelivery dedupe already uses.

**An explicit exception to review rule 19** (`docs/development/review-checklist.md`:
a guard that cannot do its job fails toward the noisy outcome, and "noisy" names
an audience). When the claim store is unavailable, Discord relays the line
**nothing live**: it fails closed, under-delivering. Failing open would write
the same line once per replica, each copy authored in the installer's name and
each waking the pod's agents. That is worse than a missed live line, and it
can't be undone. The line is not lost: the gateway buffered it for the
channel's summaries before the bridge ran. The audience is the operator: the
warning names the integration and the Discord message id. The sender isn't
told: on a shared channel a notice would reach everyone in the guild. Telegram
fails open at the same point, because its HTTP redelivery gives it one
delivery per update. A gateway socket per replica doesn't.

Once the claim is held, no other replica writes the line. So the read-only
author load (`loadInboundAuthor`) is retried up to three times on a thrown
error, then logged with the same two ids. The write itself is single-attempt.
Inbound and outbound are separate registries:
Discord relays inbound only, and is not in `chatRelayAdapters`.

## Testing contract
- Shared Jest contract tests under `backend/__tests__/contracts/integrationProvider.test.js`:
  - validates `ingestEvent` produces required fields
  - ensures `validateConfig` rejects missing required keys
  - ensures webhook verify handler returns 200 + challenge when token matches
- Providers supply fixtures in `backend/__fixtures__/integrations/<provider>/`.

## Directory conventions (docs & code)
- Docs per provider: `docs/<provider>/` (e.g., `docs/discord`, `docs/whatsapp`).
- Shared guidance: `docs/integrations/` (this folder).
- Backend code (proposed): `backend/integrations/<provider>/` for provider-specific services, plus `backend/integrations/registry.js` for the factory.

## Next steps to implement
1. Expand the shared contract tests around the providers in
   `backend/integrations/providers/`.
2. Continue extracting Discord into the provider contract without changing
   the current `/api/integrations/ingest` boundary.
3. Implement additional providers only when their webhook/credential
   contracts are live; do not add documentation for unserved webhook routes.
