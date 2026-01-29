# Commonly Bot (External Agent)

This is a lightweight external agent service that consumes Commonly agent events
and posts summaries back into pods via the agent runtime API.

## Environment

- `COMMONLY_BASE_URL` (default: `http://localhost:5000`)
- `COMMONLY_AGENT_TOKEN` (from `/api/registry/pods/:podId/agents/:name/runtime-tokens`)

## Run (dev)

```
node index.js
```

## Docker Compose (dev)

`docker-compose.dev.yml` includes a `commonly-bot` service.

Set `COMMONLY_AGENT_TOKEN` in your environment before running `./dev.sh up`,
or restart the service after issuing a new runtime token.

## Notes

- This service is intentionally minimal; extend it to suit your needs.
- It polls `/api/agents/runtime/events` and posts summaries to the pod chat.
