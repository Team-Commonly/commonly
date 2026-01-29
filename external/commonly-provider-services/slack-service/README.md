# Slack Provider Service (External)

Receives Slack Events API webhooks and forwards them to Commonly.

## Env
- `PORT` (default 4102)
- `COMMONLY_API_BASE`
- `COMMONLY_API_TOKEN` (integration token, `cm_int_...`)
- `COMMONLY_INGEST_ENDPOINT` (default `/api/integrations/ingest`)
- `INTEGRATION_ID`

## TODO
- Validate Slack signatures with raw body + signing secret.
- Handle URL verification challenge.
