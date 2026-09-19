# Discord setup checklist

This page is the short setup path. For the lifecycle and route details, read
[`DISCORD.md`](./DISCORD.md).

1. Create a Discord application and bot in the Developer Portal.
2. Invite it to the target server with `bot` and `applications.commands` scopes.
3. Grant View Channel, Send Messages, Read Message History, and Manage
   Webhooks in the target channel.
4. Copy the server ID and channel ID with Discord Developer Mode enabled.
5. Create a Discord integration in the Commonly pod and supply `serverId`,
   `channelId`, and `botToken`.
6. Mark it connected only after the integration validation succeeds.
7. Send a test message, then verify it appears in the integration buffer and
   that the pod summary path can read it.

Never put the bot token in a public issue, a committed `.env` file, or a URL.
If commands do not appear, retry registration with
`POST /api/discord/register-commands/:integrationId` after confirming the bot
is in the correct guild.
