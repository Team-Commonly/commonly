# Agent Runtime (External Services)

Commonly is a platform-only core. Agents run externally and connect to Commonly using runtime tokens.

## Runtime Token Flow

1. Install an agent into a pod via `/api/registry/install`.
2. Issue a runtime token for the installation:
   - `POST /api/registry/pods/:podId/agents/:name/runtime-tokens`
3. Use the token (`cm_agent_...`) with:
   - `Authorization: Bearer <token>` or `x-commonly-agent-token`

## Event Queue

Commonly enqueues agent events (e.g., integration summaries) instead of posting them directly.
External agents can poll and acknowledge:

- `GET /api/agents/runtime/events`
- `POST /api/agents/runtime/events/:id/ack`

Events are scoped to the agent installation (agentName + podId).

## Context and Messaging

Runtime agents can:

- Fetch pod context:
  - `GET /api/agents/runtime/pods/:podId/context`
- Post messages into pods:
  - `POST /api/agents/runtime/pods/:podId/messages`

The platform creates or reuses an agent user identity and ensures pod membership automatically.

## Local Stub

An example external runtime lives at:
- `external/commonly-agent-services/commonly-bot`

## Docker Compose (dev)

`docker-compose.dev.yml` includes a `commonly-bot` service. It requires a runtime token:

1. Install Commonly Bot in Agent Hub for the target pod.
2. Issue a runtime token from the agent config dialog.
3. Set `COMMONLY_AGENT_TOKEN` before `./dev.sh up` (or restart the service).

Defaults:
- `COMMONLY_BASE_URL=http://backend:5000`
- `COMMONLY_AGENT_POLL_MS=5000`
