# GroupMe Integration (callback + bot commands)

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

Commonly's callback is `POST /api/webhooks/groupme/:integrationId`. The
integration id is part of the callback URL; the handler checks the callback's
`group_id` against the configured integration before normalizing the event.
GroupMe V3 callbacks do not carry a signature, so this routing check is not a
sender-authentication mechanism.

## Data Flow (ingest-only)
1) Create a bot in GroupMe Dev portal; set the callback URL to `https://<your-host>/api/webhooks/groupme/<integrationId>`.
2) Invite the bot to the target group (one bot per group).
3) Group messages hit the callback → the configured `group_id` routes the message to this integration → provider normalizes → buffer → summarizer posts inside Commonly.
4) The hourly scheduler consumes buffered messages, queues a summary event for
   the installed Commonly Bot runtime, and that runtime posts the summary to
   the pod.

## Commands
- `!summary` — summarize recent GroupMe activity and post to the Commonly pod.
- `!pod-summary` (or `!pod`) — send the latest Commonly pod summary back to the GroupMe group.

## Limitations
- Bot is tied to a single group; one bot per group.
- No slash commands; only text payloads.
- Inbound messages are buffered for summaries; Commonly does not mirror every
  inbound message back to GroupMe. The supported outbound path is the GroupMe
  bot API used by `!pod-summary` and summary responses.

## Status / TODO
- ⚠️ Legacy in-platform provider (will move to external service).
- ✅ Provider registered (`groupmeProvider`)
- ✅ Webhook route `POST /api/webhooks/groupme/:integrationId`
- UI: Sidebar Apps quick-add uses a redirect flow (no inline config fields); the integration stores Bot ID for outbound replies and Group ID for callback routing (the callback does not supply Bot ID).

External service stub lives at `external/commonly-provider-services/groupme-service/`.

## Notes
- Inbound delivery is callback-based, while command and summary responses use
  the GroupMe bot API; this avoids mirroring every message and limits loops.
- Bot is tied to a single group; create multiple integrations for multiple groups.
- GroupMe callbacks have no signing primitive; a per-integration callback-URL secret is a follow-up to the current group routing check.
