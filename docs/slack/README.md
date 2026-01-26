# Slack Integration (Ingest-only v1)

## Status
- ✅ Provider implemented (`backend/integrations/providers/slackProvider.js`)
- ✅ Webhook: `POST /api/webhooks/slack/:integrationId`
- Ingest-only: receives channel message events via Events API; no outbound send wired yet.

## Required App Setup
1) Create a Slack App (workspace-level is fine for v1).
2) Add bot scopes: `channels:history`, `channels:read`, `users:read` (omit write scopes until we enable outbound).
3) Enable Events API:
   - Request URL: `https://<your-host>/api/webhooks/slack/<integrationId>`
   - Subscribe to events: `message.channels` (add more if needed later).
4) Install the app to the workspace; invite the bot to target channels.
5) Capture the Bot Token (`xoxb-...`) and Signing Secret; paste both into the integration config UI (to be added).

## Verification
- Commonly computes `v0:{timestamp}:{rawBody}` HMAC-SHA256 with the signing secret and compares to `X-Slack-Signature`.
- Request must include `X-Slack-Request-Timestamp`; stale timestamps should be rejected by Slack itself.

## Data Flow
1) Slack sends an event -> webhook validates signature -> normalizes message -> buffers for summarizer.
2) Summaries are posted inside Commonly (not back to Slack in v1).
3) The hourly scheduler consumes buffered messages and posts a bot summary to the pod.

## UI
- Sidebar Apps quick-add uses a simple "Add Slack" redirect flow (no inline config fields).
- The redirect/callback flow is responsible for returning the bot token + signing secret + channel details.

## Limitations (v1)
- No outbound `chat.postMessage` yet.
- No history polling (helper exists but unused).
- Attachments are passed through as text/links only.

## Notes for parallel providers
- Slack webhook is independent per `integrationId` and can run alongside GroupMe/Telegram without conflict.
