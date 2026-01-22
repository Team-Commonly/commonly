---
name: integrations
description: Third-party integration context for Discord API, OAuth2, webhooks, and external services. Use when working on Discord bot, API integrations, or webhook handling.
---

# Third-party Integrations

**Technologies**: Discord API, OAuth2, Webhooks, SendGrid

## Required Knowledge
- Discord Bot development and slash commands
- OAuth2 authentication flows
- Webhook handling and security
- API rate limiting
- Signature verification (Ed25519)

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [DISCORD.md](../../../docs/discord/DISCORD.md) | Main integration overview, commands |
| [DISCORD_APP_SETUP.md](../../../docs/discord/DISCORD_APP_SETUP.md) | Bot creation, credentials |
| [DISCORD_INTEGRATION_ARCHITECTURE.md](../../../docs/discord/DISCORD_INTEGRATION_ARCHITECTURE.md) | API polling, sync architecture |
| [REGISTER_DISCORD_COMMANDS.md](../../../docs/discord/REGISTER_DISCORD_COMMANDS.md) | Command registration |

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
└── integrationService.js      # Integration management
```

## Integration Flow

```
Discord Channel ──► Discord API ──► discordService.js
                                          │
                                          ▼
                                   syncRecentMessages()
                                          │
                                          ▼
                                    Gemini AI ──► Summary
                                          │
                                          ▼
                                   commonlyBotService.js
                                          │
                                          ▼
                                    Commonly Pod
```
