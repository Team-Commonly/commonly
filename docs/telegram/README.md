# Telegram Integration (Ingest-only, v1)

## What works
- Webhook ingestion via `/api/webhooks/telegram/:integrationId`
- Optional header verification with `x-telegram-bot-api-secret-token`
- Normalizes incoming `Update` objects (text/caption only) into Commonly message buffer

## Config Fields
- `botToken` (required) — for future outbound/health features
- `secretToken` (optional) — set when calling `setWebhook` to enable header verification

## Webhook Setup
1. Call `https://api.telegram.org/bot<botToken>/setWebhook` with:
   - `url`: `https://<your-host>/api/webhooks/telegram/<integrationId>`
   - `secret_token`: same value stored in integration config (optional but recommended)
2. Ensure only one webhook is set (Telegram disables `getUpdates` when webhook is active).

## Notes / Limitations
- v1 is ingest-only (no outbound send).
- Attachments are not yet parsed; we keep text/caption content.
- To avoid loops we ignore messages sent via bots (`via_bot`).

## Next Steps
- Add outbound send support (manual summary push).
- Parse common attachment types (photo/document/audio) for richer summaries.
