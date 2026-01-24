# GroupMe Integration Plan

## Goal
Read-only ingest of GroupMe group messages into Commonly pods (summary only), minimal risk to user accounts. No outbound sending in v1.

## Auth Model
- User supplies `botId` (from GroupMe developer portal) and `groupId`.
- Callback URL is set in GroupMe bot config to Commonly webhook.
- No OAuth; low risk of account ban because bot is first-party mechanism.

## Data Flow (v1)
1. GroupMe posts message events to `/api/webhooks/groupme/:integrationId`.
2. Provider verifies `bot_id` matches integration config, normalizes message, buffers for summarizer.
3. Scheduler/manual sync summarizes buffered messages and posts summary to pod.

## API Surface (backend)
- `POST /api/webhooks/groupme/:integrationId` — receives bot callbacks.
- Integration type `groupme` stored in `Integration` model.
- Optional `syncRecent` can call GroupMe history (`/groups/:group_id/messages`) if we store user access token; **defer** for now to avoid personal token storage.

## UI
- In Connections/Apps page, allow creating a GroupMe integration with fields: Bot ID, Group ID, Callback URL hint.
- Show copyable webhook URL once created.

## Anti-Ban Considerations
- Use official Bot API only (no scraping, no personal tokens in v1).
- Do not post outbound messages automatically.

## Testing
- Unit: signature/bot_id match, normalization, webhook 200/401 paths.
- Integration: webhook route happy path with sample payload.

