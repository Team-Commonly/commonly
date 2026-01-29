# Telegram Provider Service (External)

Receives Telegram bot webhooks and forwards them to Commonly.

## Env
- `PORT` (default 4103)
- `COMMONLY_API_BASE`
- `COMMONLY_API_TOKEN` (integration token, `cm_int_...`)
- `COMMONLY_INGEST_ENDPOINT` (default `/api/integrations/ingest`)
- `INTEGRATION_ID`

## TODO
- Validate `x-telegram-bot-api-secret-token` if configured.
- Normalize Telegram updates before forwarding.
