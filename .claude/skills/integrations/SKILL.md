---
name: integrations
description: Third-party integration context for Discord, Slack, GroupMe, Telegram, OAuth2, webhooks, and external services. Use when working on chat app integrations or webhook handling.
---

# Third-party Integrations

**Technologies**: Discord API, Slack API, GroupMe Bot API, Telegram Bot API, OAuth2, Webhooks, SendGrid

## Required Knowledge
- Discord Bot development and slash commands
- OAuth2 authentication flows
- Webhook handling and security
- API rate limiting
- Signature verification (Ed25519)

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [DISCORD.md](../../../docs/discord/DISCORD.md) | Discord integration overview |
| [DISCORD_APP_SETUP.md](../../../docs/discord/DISCORD_APP_SETUP.md) | Bot creation, credentials |
| [DISCORD_INTEGRATION_ARCHITECTURE.md](../../../docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md) | API polling, sync architecture |
| [REGISTER_DISCORD_COMMANDS.md](../../../docs/discord/REGISTER_DISCORD_COMMANDS.md) | Command registration |
| [slack/README.md](../../../docs/slack/README.md) | Slack webhook + signing secret notes |
| [groupme/README.md](../../../docs/groupme/README.md) | GroupMe bot ingest-only plan |
| [telegram/README.md](../../../docs/telegram/README.md) | Telegram webhook ingest with secret token |
| [design/POD_SKILLS_INDEX.md](../../../docs/design/POD_SKILLS_INDEX.md) | Pod memory, context, and LLM skill synthesis |
| [integrations/WHATSAPP_READONLY_PLAN.md](../../../docs/integrations/WHATSAPP_READONLY_PLAN.md) | WhatsApp Cloud API ingest-only |
| [integrations/MESSENGER_PLAN.md](../../../docs/integrations/MESSENGER_PLAN.md) | Messenger Page ingest-only plan |
| [integrations/WECHAT_READONLY_PLAN.md](../../../docs/integrations/WECHAT_READONLY_PLAN.md) | WeChat Official Account ingest-only plan |
| [integrations/INTEGRATION_CONTRACT.md](../../../docs/integrations/INTEGRATION_CONTRACT.md) | Provider contract and schema |
| [integrations/README.md](../../../docs/integrations/README.md) | Catalog + manifest notes |
| [integrations/COMMONLY_APP_PLATFORM.md](../../../docs/integrations/COMMONLY_APP_PLATFORM.md) | App platform design |

## Discord Slash Commands

| Command | Description |
|---------|-------------|
| `/commonly-summary` | Get pod summary in Discord |
| `/discord-status` | Show integration status |
| `/discord-enable` | Enable auto-sync |
| `/discord-disable` | Disable auto-sync |
| `/discord-push` | Manual sync trigger |

## Key Services

```
backend/services/
├── discordService.js          # Core Discord API integration
├── discordCommandService.js   # Slash command handlers
├── discordMultiCommandService.js # Fan-out for multi-pod channel commands
├── integrationSummaryService.js # Buffer summarization + agent event enqueue
├── agentEventService.js       # External agent event queue
├── telegramService.js         # Telegram helpers (universal bot)
├── podAssetService.js         # Indexed pod memory (PodAsset)
├── podContextService.js       # Agent-friendly pod context assembly
├── podSkillService.js         # LLM markdown skill synthesis
└── integrationService.js      # Integration management
```

## Integration Flows (high level)

- **Discord**: webhook interactions + REST -> `discordService` -> summarize -> enqueue agent event for external runtime. Slash commands resolve by `serverId + channelId`; multi-pod channels fan out via `discordMultiCommandService`.
- **Slack**: Events API webhook (raw body + signing secret) -> normalize -> buffer/summarize -> enqueue agent event (ingest-only v1).
- **GroupMe**: Bot callback webhook -> normalize -> buffer/summarize -> enqueue agent event (ingest-only v1).
- **Telegram**: Webhook with optional `x-telegram-bot-api-secret-token` -> normalize -> buffer/summarize -> enqueue agent event (ingest-only v1).
- **Telegram (universal bot)**: Single webhook `/api/webhooks/telegram` routes by `chat_id`; `/commonly-enable <code>` links a chat to a pod.

All providers implement the shared contract in `packages/integration-sdk` and are registered in `backend/integrations/index.js`.

## Catalogs, manifests, and pod memory

- Integration metadata is manifest-driven.
- Integration manifests live in `backend/integrations/manifests.js` and are re-exported from `packages/integration-sdk`.
- Official marketplace listings live in `packages/commonly-marketplace/marketplace.json` and are served by `GET /api/marketplace/official`.
- `GET /api/integrations/catalog` returns integration metadata plus per-user stats for the UI.
- Integration create/update routes enforce manifest-required fields when status is set to `connected`.
- Summaries are persisted as indexed pod memory via `PodAsset` (for example `type='integration-summary'`).
- `GET /api/pods/:id/context` reads PodAssets and can synthesize LLM markdown skills into `PodAsset(type='skill')`.
- External agent runtimes poll `/api/agents/runtime/events` and post into pods via `/api/agents/runtime/pods/:podId/messages`.

## Clawdbot Integration

Clawdbot is an external AI agent runtime that connects personal channels (Discord, Slack, Telegram) to Commonly pods.

### Architecture

- **Clawdbot Gateway**: AI runtime with skills and channel support
- **Clawdbot Bridge**: Polls Commonly events, calls gateway, posts responses
- **Skills**: Curl-based integrations (commonly skill provides pod access)
- **Channels**: Discord, Telegram, Slack (configured via moltbot.json)

### Separate Discord Bots

Clawdbot uses a **separate Discord bot** to avoid conflicts with Commonly's slash commands:

| Bot | Purpose | Env Variables |
|-----|---------|---------------|
| Commonly Bot | Slash commands (`/commonly-summary`, `/discord-push`) | `DISCORD_CLIENT_ID`, `DISCORD_BOT_TOKEN` |
| Clawdbot Bot | AI agent for natural language chat (mention-only) | `CLAWDBOT_DISCORD_CLIENT_ID`, `CLAWDBOT_DISCORD_BOT_TOKEN` |

**Discord mention-only config:**
```json
"discord": {
  "enabled": true,
  "token": "${DISCORD_BOT_TOKEN}",
  "groupPolicy": "open",
  "guilds": { "*": { "requireMention": true } }
}
```

### Slack Socket Mode

Clawdbot uses Slack Socket Mode (no public webhook). Required setup:
- **Enable Socket Mode** in Slack app settings
- **Event subscriptions**: `message.channels`, `message.groups`, `message.im`, `app_mention`
- **OAuth scopes**: `channels:history`, `chat:write`, `groups:history`, `im:history`, `app_mentions:read`
- **Reinstall app** after adding scopes
- **Invite bot** to channels with `/invite @BotName`

### Key Files

```
external/clawdbot-state/config/
├── moltbot.json                    # Gateway + channel configuration
└── skills/commonly/SKILL.md        # Commonly API skill (curl-based)

external/commonly-agent-services/
├── commonly-bot/manifest.json      # Platform bot agent
└── clawdbot-bridge/manifest.json   # Bridge agent definition

backend/services/agentBootstrapService.js    # Auto-registers agents on startup
backend/routes/health.js                     # GET /api/health/clawdbot endpoint
frontend/src/components/agents/ClawdbotConfigPanel.js  # UI for Clawdbot config
```

### Commands

```bash
./dev.sh clawdbot up       # Start Clawdbot services
./dev.sh clawdbot down     # Stop services

# Debug commands
docker logs clawdbot-gateway-dev --tail 50
docker exec clawdbot-gateway-dev node dist/index.js skills list
docker exec clawdbot-gateway-dev tail -50 /home/node/.clawdbot/agents/main/sessions/*.jsonl
```

### Commonly Skill

The `commonly` skill provides curl-based access to Commonly pods. Usage via natural language:
- "What pods do I have access to in Commonly?"
- "Search the Engineering pod for deployment docs"
- "Post 'Task completed!' to the Support pod"

### Runtime Tokens

- Generate via AgentsHub UI -> clawdbot-bridge -> Settings
- Token format: `cm_agent_*`
- Environment variable: `COMMONLY_API_TOKEN`

### Troubleshooting

**Bot typing but no response**: Check for API rate limits (HTTP 429)
```bash
docker exec clawdbot-gateway-dev tail -50 \
  /home/node/.clawdbot/agents/main/sessions/*.jsonl | grep -i error
```

**Skill shows "missing"**: Check dependencies
```bash
docker exec clawdbot-gateway-dev node dist/index.js skills list | grep commonly
```

### Documentation

See [CLAWDBOT.md](../../../docs/agents/CLAWDBOT.md) for full configuration.

## Operational Notes

- **Discord interactions endpoint** must be publicly reachable at `/api/discord/interactions`. If using Cloudflare Tunnel, the hostname must be added to the tunnel ingress (DNS-only changes will return Cloudflare 404s and Discord verification will fail).
