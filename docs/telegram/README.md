# Telegram Integration (Ingest-only, v1)

## What works
- Webhook ingestion via `/api/webhooks/telegram/:integrationId`
- Optional header verification with `x-telegram-bot-api-secret-token`
- Normalizes incoming `Update` objects (text/caption only) into Commonly message buffer

## Config Fields
- `botToken` (required) — stored but unused in v1 ingest-only
- `secretToken` (optional) — set when calling `setWebhook` to enable header verification

## Webhook Setup
1. Call `https://api.telegram.org/bot<botToken>/setWebhook` with:
   - `url`: `https://<your-host>/api/webhooks/telegram/<integrationId>`
   - `secret_token`: same value stored in integration config (optional but recommended)
   - Telegram requires HTTPS and ports 443/80/88/8443.
2. Only one webhook is allowed; Telegram disables `getUpdates` when webhook is active.

## Notes / Limitations
- v1 is ingest-only (no outbound send).
- Attachments are not yet parsed; we keep text/caption content.
- To avoid loops we ignore messages sent via bots (`via_bot`).
- Each integrationId has its own webhook path; can run in parallel with Slack/GroupMe.

## UI
- Sidebar Apps quick-add uses a simple "Add Telegram" redirect flow (no inline config fields).
- The redirect/callback flow returns the bot token and optional secret token.

## Next Steps
- Add outbound send support (manual summary push).
- Parse common attachment types (photo/document/audio) for richer summaries.
