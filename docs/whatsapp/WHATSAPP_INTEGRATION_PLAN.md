# WhatsApp Integration Plan

## Goals
- Add a WhatsApp Cloud API integration that mirrors the existing Discord integration flow (sync recent messages, summarize, and post into a Commonly pod).
- Support webhook-based inbound message capture and scheduled/commanded summary generation.
- Keep integration management consistent with existing `Integration` records.

## Non-Goals (initial phase)
- Full two-way chat sync between pods and WhatsApp (only WhatsApp → Commonly summary in phase 1).
- Rich media handling beyond basic text (expand later).
- Multi-number routing (start with one phone number per integration).

## Integration Options
### A) WhatsApp Cloud API (preferred)
- Official Meta platform, webhook-based.
- Requires phone number ID, WABA ID, and access token.
- Allows server-side webhooks and message sending.

### B) Telegram Bot API (fallback)
- Simpler setup (bot token + webhook).
- Lower compliance overhead.
- Good for early validation if WhatsApp compliance/onboarding slows delivery.

## Recommended Path
1. Build WhatsApp Cloud API integration.
2. If onboarding delays or webhook verification blocks progress, ship Telegram integration first using the same integration framework.

## Architecture Fit
- Reuse `Integration` collection with `type: 'whatsapp'` (extend enum).
- Add new WhatsApp-specific model (parallel to `DiscordIntegration`).
- Add a `whatsappService.js` similar to `discordService.js` for:
  - webhook validation
  - message parsing
  - summary creation + posting to pod
  - health checks

## Backend Changes (planned)
- **Models**
  - `backend/models/WhatsAppIntegration.js`
    - `integrationId`, `wabaId`, `phoneNumberId`, `accessToken`, `verifyToken`, `webhookUrl`, `status`.
- **Services**
  - `backend/services/whatsappService.js` for webhook handling + summary sync.
- **Routes**
  - `backend/routes/webhooks/whatsapp.js` for GET verify + POST events.
  - `backend/routes/whatsapp.js` for setup, health, and manual sync endpoints.
- **Scheduler**
  - Extend `schedulerService.js` to include WhatsApp integrations (similar to Discord hourly sync).

## API & Webhooks (from Meta docs)
- **Webhook verification**: GET with `hub.mode`, `hub.verify_token`, `hub.challenge`.
- **Incoming message webhook**: POST event with `entry[].changes[].value.messages[]`.
- **Send message**: POST `/<PHONE_NUMBER_ID>/messages` with `messaging_product: "whatsapp"`.

## Data Flow (Phase 1)
1. WhatsApp webhook receives new messages.
2. Persist minimal message buffer to integration record.
3. On schedule or manual trigger, summarize recent messages with Gemini.
4. Enqueue an agent event for the external Commonly Bot to post into the pod.

## Security & Compliance
- Store access tokens encrypted (use existing secrets pattern).
- Validate webhook signatures if available (Meta provides X-Hub-Signature-256 for webhooks).
- Rate limit webhook endpoint and enforce allowlist if possible.

## Testing Plan
- Unit tests for message parsing + verification token checks.
- Integration tests for webhook endpoint (GET verify + POST payload).
- Mock WhatsApp payload fixtures.

## Milestones
1. Docs + schema updates
2. Webhook endpoint + verification
3. Message parsing + storage
4. Summary generation + pod posting
5. Manual sync endpoint + health check
6. E2E verification

## Open Questions
- Do we want an interactive setup UI like Discord OAuth or manual config only?
- Should we store multiple phone numbers per pod?
- Do we need outbound posting to WhatsApp in phase 1?
