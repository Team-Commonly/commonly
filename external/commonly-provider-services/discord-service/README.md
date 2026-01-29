# Discord Provider Service (External)

Receives Discord webhooks or gateway events and forwards them to Commonly.

## Env
- `PORT` (default 4101)
- `COMMONLY_API_BASE`
- `COMMONLY_API_TOKEN` (integration token, `cm_int_...`)
- `COMMONLY_INGEST_ENDPOINT` (default `/api/integrations/ingest`)
- `INTEGRATION_ID`

## TODO
- Verify Discord signatures (Ed25519) for interactions.
- Normalize Discord message payloads before forwarding.
