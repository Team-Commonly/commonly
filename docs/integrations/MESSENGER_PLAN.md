# Messenger Integration Plan (Ingest-only, Page-based)

Status: Planned — use only Page messaging via Meta Graph API. No personal accounts.

## Scope
- One-way ingest: messages sent to the Page are forwarded into Commonly for summarization.
- No outbound replies in v1.

## Auth & Verification
- User supplies:
  - Page Access Token (from their Meta app/Page)
  - Verify Token (arbitrary string they configure)
- Webhook verification: `hub.mode`, `hub.challenge`, `hub.verify_token`.
- App Secret Proof optional (add if we make outbound calls later).

## Webhook Endpoint (planned)
- `POST /api/webhooks/messenger/:integrationId`
- `GET /api/webhooks/messenger/:integrationId` responds to `hub.challenge`.

## Event Flow
1) Page receives a message.
2) Meta POSTs to Commonly webhook with `entry[].messaging[]`.
3) Provider validates verify token, normalizes message, buffers for summarizer.

## Data Mapping
- messageId: `mid`
- authorId: `sender.id`
- authorName: (not provided in webhook; optional graph lookup later)
- content: `message.text` (ignore attachments v1)
- timestamp: `timestamp`

## Risks / Constraints
- Requires Page Messaging permission; app must be in Live mode for real users.
- Personal tokens or unofficial methods risk bans — do not support.

## Next Steps
- Implement provider + webhook verify for Messenger.
- Add user-facing setup doc (Page creation, webhook subscription, tokens).
- Add unit tests for verify token path and normalization.
