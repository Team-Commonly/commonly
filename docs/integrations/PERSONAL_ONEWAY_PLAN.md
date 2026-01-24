# Personal One-way Sync Plan (Messenger, WhatsApp, WeChat)

Goal: let an individual forward their own chat messages into a Commonly pod for summarization, without sending messages back to the platforms. Stick to official APIs to avoid bans.

## Shared Principles
- **Ingest-only**: Webhooks only; no outbound send in v1.
- **User-provided auth**: Tokens/keys supplied by the user; store encrypted per integration.
- **Isolation**: Separate webhook per integrationId; no cross-talk between providers.
- **Minimal PII**: Store text, sender id/name, timestamp, lightweight attachments; allow buffer deletion.

## Messenger (Meta, Page-based)
- Auth: Page Access Token + verify token (user supplies both).
- Verify: `hub.mode`, `hub.challenge`, `hub.verify_token`.
- Events: `messages`, `messaging_postbacks` for the Page.
- Setup: user creates Page + app, subscribes Page to webhook, configures verify token.
- Risk: Requires app with Page Messaging permission in Live mode; personal tokens not allowed.
- Outbound: disabled in v1.

## WhatsApp (Cloud API only)
- Auth: `phone_number_id`, access token, verify token (user supplies).
- Verify: `hub.mode`, `hub.challenge`, `hub.verify_token`; support `X-Hub-Signature-256` when key available.
- Events: `entry[].changes[].value.messages[]` → normalize to buffer.
- Risk: Must follow Meta policy; avoid device bridges.
- Outbound: disabled in v1 to avoid template review overhead.

## WeChat (Official Account passive ingest)
- Channel: OA server callbacks (Service/Subscription account).
- Verify: SHA1 of `token|timestamp|nonce`, respond with `echostr` on GET.
- Messages: XML POST (text/image/etc.); normalize text + basic media URLs.
- Setup: user sets webhook URL + token in OA platform; no user OAuth needed for ingest-only.
- Risk: Content rules strict; keep ingest-only, no replies.

## Data Mapping
- messageId, authorId, authorName, content, timestamp, attachments (URLs), raw (short-term optional).

## Planned Webhook Endpoints
- `/api/webhooks/messenger/:integrationId`
- `/api/webhooks/whatsapp/:integrationId`
- `/api/webhooks/wechat/:integrationId`

## Next Steps
1) Implement webhook verify + ingest-only providers for Messenger (Page), WhatsApp Cloud API, WeChat OA.
2) Add end-user setup docs with screenshots/URL examples.
3) UI: per-provider form with required fields and generated webhook URL.
4) Provider unit tests: verify token/signature paths and normalization.
