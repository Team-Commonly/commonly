# GroupMe Provider Service (External)

Receives GroupMe bot callbacks and forwards them to Commonly.

## Env
- `PORT` (default 4104)
- `COMMONLY_API_BASE`
- `COMMONLY_API_TOKEN` (integration token, `cm_int_...`)
- `COMMONLY_INGEST_ENDPOINT` (default `/api/integrations/ingest`)
- `INTEGRATION_ID`

## TODO
- Validate GroupMe signatures if enabled.
- Normalize GroupMe payloads before forwarding.
