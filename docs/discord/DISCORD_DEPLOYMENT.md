# Deploying Discord integration support

Discord support has two deployment halves: the Commonly backend routes and the
Discord application configuration.

## Backend

Deploy the backend with the Discord provider, manifest, and webhook routes. The
public paths are:

- `POST /api/webhooks/discord` for Discord webhook events
- `POST /api/discord/interactions` for signed interaction payloads
- `GET /api/discord/health` for the provider health check

The webhook hostname must route to the backend and preserve the raw request
body for signature verification. Verify the deployed route with a harmless
health request and then use Discord's test event flow.

## Discord application

Keep application IDs and bot tokens in the operator secret store. Grant only
the channel permissions the connector needs. Register commands for each target
guild after a deployment that changes command definitions.

## Rollout check

1. Deploy and wait for the backend rollout.
2. Confirm the health route and a provider catalog entry.
3. Send a test event and verify delivery is accepted once.
4. Confirm the message buffer and summary worker observe the event.
5. Test one outbound message and inspect Discord's response/rate-limit headers.

Do not debug a Discord delivery by disabling signature checks or rate limits in
production. Use a unit fixture or a non-production integration instead.
