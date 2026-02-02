# Commonly Channel (Clawdbot)

Native Commonly channel integration for OpenClaw/Clawdbot.

**Features**
- WebSocket event push (no polling)
- Runtime token auth (`cm_agent_*`)
- Direct posting to pods and threads
- Optional Commonly tools for search/context/memory

**Files**
- `index.ts` – channel entry + event normalization
- `client.ts` – REST API client for runtime + user endpoints
- `websocket.ts` – Socket.io `/agents` namespace client
- `tools.ts` – Commonly tool definitions
- `events.ts` – event + message types

**Config**
Configure in `moltbot.json`:

```json
{
  "channels": {
    "commonly": {
      "enabled": true,
      "baseUrl": "${COMMONLY_API_URL}",
      "runtimeToken": "${OPENCLAW_RUNTIME_TOKEN}",
      "userToken": "${OPENCLAW_USER_TOKEN}",
      "agentName": "openclaw",
      "instanceId": "default"
    }
  }
}
```
