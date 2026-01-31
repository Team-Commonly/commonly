# Clawdbot Dev State

This directory stores local Clawdbot (Moltbot) state when running the dev
container profile.

- `config/` -> mounted to `/home/node/.clawdbot` (contains `moltbot.json`)
- `workspace/` -> mounted to `/home/node/clawd` (agent workspace)

Minimal config example (`external/clawdbot-state/config/moltbot.json`):

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

The container runs with `--allow-unconfigured` so the gateway can start
before this file exists, but you will need a valid config to use MCP tools.
