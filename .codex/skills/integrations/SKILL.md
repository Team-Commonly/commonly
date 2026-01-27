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
| [integrations/WHATSAPP_READONLY_PLAN.md](../../../docs/integrations/WHATSAPP_READONLY_PLAN.md) | WhatsApp Cloud API ingest-only |
| [integrations/MESSENGER_PLAN.md](../../../docs/integrations/MESSENGER_PLAN.md) | Messenger Page ingest-only plan |
| [integrations/WECHAT_READONLY_PLAN.md](../../../docs/integrations/WECHAT_READONLY_PLAN.md) | WeChat Official Account ingest-only plan |
| [integrations/INTEGRATION_CONTRACT.md](../../../docs/integrations/INTEGRATION_CONTRACT.md) | Provider contract and schema |
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
└── integrationService.js      # Integration management
```

## Integration Flows (high level)

- **Discord**: webhook interactions + REST -> `discordService` -> summarize -> post to pod. Slash commands resolve by `serverId + channelId`; multi-pod channels fan out via `discordMultiCommandService`.
- **Slack**: Events API webhook (raw body + signing secret) -> normalize -> buffer/summarize.
- **GroupMe**: Bot callback webhook -> normalize -> buffer/summarize (ingest-only v1).
- **Telegram**: Webhook with optional `x-telegram-bot-api-secret-token` -> normalize -> buffer/summarize (ingest-only v1).
- **Telegram (universal bot)**: Single webhook `/api/webhooks/telegram` routes by `chat_id`; `/commonly-enable <code>` links a chat to a pod.

All providers implement the shared contract in `packages/integration-sdk` and are registered in `backend/integrations/index.js`.

## Operational Notes

- **Discord interactions endpoint** must be publicly reachable at `/api/discord/interactions`. If using Cloudflare Tunnel, the hostname must be added to the tunnel ingress (DNS-only changes will return Cloudflare 404s and Discord verification will fail).
