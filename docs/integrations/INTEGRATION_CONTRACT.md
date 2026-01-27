# External Integration Contract (Draft)

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
5) **Summarize**: feed normalized messages to summarizer; persist the result as pod memory (`PodAsset`) and post to the pod via `CommonlyBotService`.
6) **Health**: `/api/<provider>/health` delegates to `health()`.

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

## Security requirements
- Webhook signature/verify-token checks mandatory; reject on mismatch.
- Rate-limit webhook routes; strip PII beyond what’s needed for summaries.
- Store secrets encrypted (reuse existing config patterns).

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
1. Add `integrationRegistry` + contract tests scaffold.
2. Extract Discord into a provider implementing this contract.
3. Implement WhatsApp provider against the contract.
4. (Optional) Add Telegram provider to validate multi-provider design.
