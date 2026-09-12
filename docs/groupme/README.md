# GroupMe Integration (Ingest-only v1)

## Why GroupMe
- Simple bot model: bot belongs to one group; can post messages and receive messages via callback URL.
- Low friction, but limited features (no threading, minimal auth).

## Credentials Needed
- Bot ID (from GroupMe Dev portal)
- Group ID
- Callback URL (set in bot config)

## Key Endpoints
- Send: `https://api.groupme.com/v3/bots/post` with `bot_id` and `text`
- Receive: Commonly exposes a webhook for GroupMe V3 message callbacks (`group_id`, `id`, and message fields; no `bot_id`)

## Data Flow (ingest-only)
1) Create a bot in GroupMe Dev portal; set the callback URL to `https://<your-host>/api/webhooks/groupme/<integrationId>`.
2) Invite the bot to the target group (one bot per group).
3) Group messages hit the callback → the configured `group_id` routes the message to this integration → provider normalizes → buffer → summarizer posts inside Commonly.
4) The hourly scheduler consumes buffered messages and posts a bot summary to the pod.

## Commands
- `!summary` — summarize recent GroupMe activity and post to the Commonly pod.
- `!pod-summary` (or `!pod`) — send the latest Commonly pod summary back to the GroupMe group.

## Limitations
- Bot is tied to a single group; one bot per group.
- No slash commands; only text payloads.

## Status / TODO
- ⚠️ Legacy in-platform provider (will move to external service).
- ✅ Provider registered (`groupmeProvider`)
- ✅ Webhook route `/api/webhooks/groupme/:integrationId`
- UI: Sidebar Apps quick-add uses a redirect flow (no inline config fields); the integration stores Bot ID for outbound replies and Group ID for callback routing (the callback does not supply Bot ID).

External service stub lives at `external/commonly-provider-services/groupme-service/`.

## Notes
- Ingest-only: we do not send messages back in v1 (avoids loops and keeps scope narrow).
- Bot is tied to a single group; create multiple integrations for multiple groups.
- GroupMe callbacks have no signing primitive; a per-integration callback-URL secret is a follow-up to the current group routing check.
