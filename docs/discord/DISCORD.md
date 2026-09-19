# Discord integration

The Discord connector links one Discord server/channel to a Commonly pod. It
can ingest channel events, summarize them into the pod, and send pod summaries
back through the configured Discord integration. The integration provider and
manifest are the source of truth; this page is the operator guide.

## Prerequisites

Create a Discord application and bot in the [Discord Developer
Portal](https://discord.com/developers/applications). Invite the bot to the
target server with these permissions in the target channel:

- View Channel
- Send Messages
- Read Message History
- Manage Webhooks

Keep the bot token private. Enable the Message Content intent if the Discord
application requires it for the event payloads you ingest.

## Configure in Commonly

Create a Discord integration from the pod's integration UI or the integration
API. The manifest requires:

| Field | Meaning |
|---|---|
| `serverId` | Discord guild/server ID |
| `channelId` | Channel to ingest and target for outbound messages |
| `botToken` | Bot credential, stored as secret configuration |

The catalog endpoint is `GET /api/integrations/catalog`. Integration lifecycle
routes are under `/api/integrations`; a connected integration is validated
against its manifest before it is marked ready.

## Delivery paths

Inbound Discord webhooks are handled at `POST /api/webhooks/discord` and are
rate-limited and deduplicated. Discord interactions are received at
`POST /api/discord/interactions`. Management and health routes are under
`/api/discord`, including:

- `GET /api/discord/channels/:guildId`
- `GET /api/discord/health`
- `POST /api/discord/register-commands/:integrationId`
- `GET /api/discord/binding/:podId`
- `DELETE /api/discord/uninstall/:installationId`

The connector normalizes inbound messages, buffers them for the summarizer,
and uses the provider to send an approved outbound message. The generic
integration routes remain the place to inspect status, messages, and stats.

## Slash commands

The Discord provider registers the commands it supports for the configured
guild. Registration can be retried with the management route above. If a
command is missing, check that the bot is in the server, the application has
the `applications.commands` scope, and the integration's server ID matches
the guild where the command was registered.

## Troubleshooting

1. `401` or `403`: rotate the bot token in Discord and update the integration;
   then verify the bot's channel permissions.
2. No inbound messages: check the public webhook/interaction route, raw-body
   handling, and the server/channel IDs. Inspect backend logs by integration
   ID, not by copying a token into a ticket.
3. Duplicate summaries: check the provider delivery ID and the integration
   buffer before retrying the external event.
4. Outbound failure: use the integration status/send path and confirm Discord
   rate limits; do not loop retries without backoff.

Related code: `backend/integrations/providers/discordProvider.ts`,
`backend/services/discordService.ts`, and `backend/routes/discord.ts`.
