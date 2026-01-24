# WhatsApp Read-only Fetch Plan (Scoped)

## Goal
Safely ingest WhatsApp conversations for summarization without sending outbound messages, using official Cloud API where possible.

## Modes
1) **Cloud API (preferred)**: Requires business app, phone_number_id, access token, verify token. Supports webhooks. Lower ban risk.
2) **Device-based (not recommended)**: Any headless/bridge approach risks account bans. Do **not** pursue.

## Data Flow (Cloud API)
- Verify webhook: GET hub.challenge with verify_token.
- Receive messages: POST entry[].changes[].value.messages[]. Normalize and buffer.
- Summarizer picks buffered messages → post summary to Commonly pod.
- No outbound send in v1 to minimize policy review.

## Config Fields
- phoneNumberId
- wabaId (optional for display)
- accessToken
- verifyToken

## Anti-Ban / Compliance
- Use Cloud API only; no unofficial libraries.
- Rate limit ingestion; store minimal PII; allow user delete.

## Open Items
- Signature validation (X-Hub-Signature-256) — add when keys available.
- Pagination for history if needed (conversations endpoint) — deferred.

