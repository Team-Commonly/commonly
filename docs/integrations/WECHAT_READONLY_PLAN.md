# WeChat Official Account Ingest-only Plan

## Scope
- Passive ingest of messages sent to a Service/Subscription Official Account.
- No replies in v1 (keeps within OA rules and reduces review burden).

## Verification
- WeChat sends GET with `signature`, `timestamp`, `nonce`, `echostr`.
- Compute SHA1 of sorted `[token, timestamp, nonce]`; if matches `signature`, respond with `echostr`.
- Token is a developer-chosen string configured in WeChat OA platform.

## Message Flow
- POST payloads are XML (text/image/location/etc.).
- Normalize to: messageId, authorId (`FromUserName`), authorName (not provided), content (text or caption), timestamp (`CreateTime`), attachments (media URLs if provided), raw (optional, short-lived).
- Store minimal data in message buffer for summarizer.

## Config Fields
- verifyToken (the OA token)
- appId (optional, for display)
- encodingAESKey (if message encryption enabled; v1 assume plaintext)

## Webhook Endpoint (planned)
- `/api/webhooks/wechat/:integrationId`
  - GET: verification echo
  - POST: XML ingest → buffer

## Risks / Compliance
- OA content policies are strict; do not send replies automatically.
- If encryption is enabled, must implement AES decryption; defer to v2.

## Next Steps
1) Implement verify handler + XML parsing for ingest-only.
2) Add unit tests for signature verification and XML normalization.
3) Add user setup doc (where to set token + URL in OA console).
