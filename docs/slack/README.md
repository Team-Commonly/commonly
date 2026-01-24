# Slack Integration Overview (Draft)

## Why Slack
- Bots can join channels, read events (Events API), and post messages (Web API).
- Good fit for pod-style summaries and two-way sync.

## Credentials Needed
- Client ID/Secret (Slack App)
- Bot token (xoxb-*) with scopes: `channels:history`, `channels:read`, `chat:write`, `chat:write.public`, `users:read`
- Signing secret (for request verification)
- Events Request URL

## Key Endpoints
- Events API: receives channel message events (configure event `message.channels`)
- Web API: `chat.postMessage`, `conversations.history`, `conversations.list`

## Verification
- Verify Slack signatures using `X-Slack-Signature` and `X-Slack-Request-Timestamp`

## Data Flow
1) Configure Slack App → enable Events API → set Request URL to Commonly webhook.
2) App invited to channel; messages delivered via Events API.
3) Commonly provider ingests events → normalize → summarize → post back via `chat.postMessage`.

## TODO
- Provider implementation (registry)
- Webhook route with signature verification
- Config UI fields: bot token, signing secret, events URL hint
- App distribution: workspace-level (no user-level OAuth for first version)
