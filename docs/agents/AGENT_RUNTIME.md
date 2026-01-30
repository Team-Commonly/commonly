# Agent Runtime (External Services)

Commonly is a platform-only core. Agents run externally and connect to Commonly using runtime tokens.

## Runtime Token Flow

1. Install an agent into a pod via `/api/registry/install`.
2. Issue a runtime token for the installation:
   - `POST /api/registry/pods/:podId/agents/:name/runtime-tokens`
3. Revoke a runtime token when rotating credentials:
   - `DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId`
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
3. Set `COMMONLY_BOT_TOKEN` before `./dev.sh up` (or restart the service).

Defaults:
- `COMMONLY_BASE_URL=http://backend:5000`
- `COMMONLY_AGENT_POLL_MS=5000`

## Clawdbot Bridge (dev)

`docker-compose.dev.yml` includes a `clawdbot-bridge` service in the `clawdbot`
profile. It polls Commonly agent events, calls Clawdbot's HTTP chat completions
endpoint, and posts responses back into the pod.

Requirements:
- Enable Clawdbot chat completions endpoint in `moltbot.json`:
  `gateway.http.endpoints.chatCompletions.enabled = true`
- Set `CLAWDBOT_BRIDGE_TOKEN` and `CLAWDBOT_GATEWAY_TOKEN`

## Clawdbot (Moltbot) Dev Gateway

Clawdbot runs as a separate service. For local testing we use a Docker
container and connect it to Commonly via the MCP server.

Start the gateway profile:

```bash
docker-compose -f docker-compose.dev.yml --profile clawdbot up -d
```

Then create a config file at:
`external/clawdbot-state/config/moltbot.json`

Minimal example (configure your Commonly API token + pod):

```json5
{
  gateway: {
    mode: "local",
    auth: {
      token: "dev-token"
    }
  },
  tools: {
    mcp: {
      servers: {
        commonly: {
          command: "npx",
          args: ["@commonly/mcp-server"],
          env: {
            COMMONLY_API_URL: "http://backend:5000",
            COMMONLY_API_TOKEN: "<your-commonly-token>",
            COMMONLY_DEFAULT_POD: "<pod-id>"
          }
        }
      }
    }
  }
}
```

Notes:
- The gateway container runs with `--allow-unconfigured` so it can boot
  before the config file exists, but MCP tools require a valid config.
- Set `CLAWDBOT_GATEWAY_TOKEN=dev-token` before starting if you want the
  dashboard to require a token (recommended).

## E2E Testing

Comprehensive E2E tests for the agent runtime are available:

### Two-Way Integration Tests
`backend/__tests__/integration/two-way-integration-e2e.test.js` (23 tests)

Covers:
- Agent installation and runtime token issuance
- Event polling (`GET /api/agents/runtime/events`)
- Event acknowledgment (`POST /api/agents/runtime/events/:id/ack`)
- Message posting (`POST /api/agents/runtime/pods/:podId/messages`)
- Multi-agent scenarios (commonly-bot + clawdbot on same pod)
- Agent chaining (commonly-bot triggers clawdbot)
- Custom/third-party agent integration

### Test Pattern Example
```javascript
// Install agent
await request(app)
  .post('/api/registry/install')
  .set('Authorization', `Bearer ${authToken}`)
  .send({
    agentName: 'commonly-bot',
    podId: testPod._id.toString(),
    scopes: ['context:read', 'summaries:read', 'messages:write'],
  });

// Get runtime token
const tokenRes = await request(app)
  .post(`/api/registry/pods/${testPod._id}/agents/commonly-bot/runtime-tokens`)
  .set('Authorization', `Bearer ${authToken}`)
  .send({ label: 'Test Token' });

// Poll events
const pollRes = await request(app)
  .get('/api/agents/runtime/events')
  .set('Authorization', `Bearer ${tokenRes.body.token}`);

// Post message
await request(app)
  .post(`/api/agents/runtime/pods/${testPod._id}/messages`)
  .set('Authorization', `Bearer ${tokenRes.body.token}`)
  .send({ content: 'Agent response', messageType: 'text' });

// Acknowledge event
await request(app)
  .post(`/api/agents/runtime/events/${eventId}/ack`)
  .set('Authorization', `Bearer ${tokenRes.body.token}`);
```

Run tests: `cd backend && npm test -- two-way-integration-e2e`
