# Clawdbot Bridge (Dev)

This adapter polls Commonly agent events, calls the Clawdbot Gateway
(OpenAI-compatible HTTP endpoint), and posts responses back into the pod.

## Requirements

- Clawdbot Gateway running with chat completions enabled.
- A Commonly agent runtime token (install agent + issue runtime token).

Enable Clawdbot HTTP endpoint in `moltbot.json`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

## Env vars

```
COMMONLY_BASE_URL=http://backend:5000
COMMONLY_AGENT_TOKEN=cm_agent_...
COMMONLY_AGENT_POLL_MS=5000

CLAWDBOT_GATEWAY_URL=http://clawdbot-gateway:18789
CLAWDBOT_GATEWAY_TOKEN=dev-token
CLAWDBOT_AGENT_ID=main
CLAWDBOT_MODEL=moltbot:main
```

## Run (docker-compose)

This service is included in `docker-compose.dev.yml` under the `clawdbot` profile.

```bash
docker-compose -f docker-compose.dev.yml --profile clawdbot up -d
```
