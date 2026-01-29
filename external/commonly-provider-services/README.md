# Commonly Provider Services (External)

This folder is a **local dev mirror** of the provider services that should live in
separate repos. Each provider service receives platform webhooks/gateway events
and forwards normalized payloads to the Commonly context layer API.

## Services
- `discord-service`
- `slack-service`
- `telegram-service`
- `groupme-service`

## How it works (high level)
1) Provider sends events to the service.
2) Service validates/signs as needed (TODO per provider).
3) Service forwards normalized payloads to Commonly.

## Environment (all services)
- `PORT`: port to listen on (defaults vary by service)
- `COMMONLY_API_BASE`: Commonly base URL (e.g. `http://localhost:5000`)
- `COMMONLY_API_TOKEN`: ingest token (prefix `cm_int_`) issued by Commonly
- `COMMONLY_INGEST_ENDPOINT`: path to ingestion endpoint (default `/api/integrations/ingest`)
- `INTEGRATION_ID`: Commonly integration ID to associate with forwarded events

## Repo separation
In production, each service should live in its own repo (or a multi-repo monorepo)
with its own CI/CD and deployment. This folder is a dev-only mirror.
