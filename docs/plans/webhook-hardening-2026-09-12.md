# Webhook hardening design note (B2)

**Status:** proposed for implementation 2026-09-12  
**Owner:** Connectors lane (Kai); Wren design read, Vera exact-head gate

## Scope and invariants

All provider routes claim a delivery before running provider work. The claim is
an atomic `WebhookDelivery` row and is released when processing fails before a
provider-side write. A duplicate claim is acknowledged without running the
handler. Claims are namespaced by provider and provider account in the
`deliveryId` value so independent bots/workspaces cannot collide while the
existing `{ provider, deliveryId }` unique index remains compatible.

The existing Telegram contract stays unchanged: `update_id`, a 10-minute TTL,
and `TELEGRAM_SECRET_TOKEN` verification with the explicit local-dev
`TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED=true` escape hatch.

## Provider identities, verification, and retention

| Provider | Canonical delivery identity | Verification | TTL |
| --- | --- | --- | --- |
| Slack Events API | `team_id:event_id` | HMAC over the raw body (`v0:{timestamp}:{body}`), with a 300-second timestamp window; missing/invalid secret or signature is `401` | 24 hours |
| GroupMe callback | `bot_id:message.id` | Require configured `bot_id` and matching callback `bot_id`; GroupMe exposes no signing primitive. Missing/mismatched identity is `401`. `GROUPME_WEBHOOK_ALLOW_UNVERIFIED=true` is an explicit local/dev escape hatch | 24 hours |
| Discord webhook events | `webhook_id:event.id` | Ed25519 over `X-Signature-Timestamp + raw body` using `DISCORD_PUBLIC_KEY`; missing/invalid headers or key is `401`. `DISCORD_WEBHOOK_ALLOW_UNVERIFIED=true` is an explicit local/dev escape hatch | 24 hours |

Slack URL-verification challenges are authenticated before returning the
challenge. Discord PINGs are authenticated before returning PONG. Requests
without a provider delivery id are rejected (`400`) on event paths rather than
processed without deduplication.

## Rollout order (no delivery gap)

1. Ship the shared model/service and indexes first; the additive collection is
   safe for old routes and existing Telegram rows.
2. Deploy verification + claim-before-run one provider at a time, starting with
   Slack (already signed), then GroupMe, then Discord. Keep each provider's old
   route and response shape while the new gate is in front of it.
3. Configure secrets/keys and register provider callbacks before enabling the
   corresponding fail-closed path. The explicit unverified flags are for local
   development only and are not set in production.
4. Confirm duplicate, stale/fresh signature, missing-secret, and provider
   verification tests in CI, then remove the obsolete Slack receipt path after
   one retention window (24 hours) has elapsed in production.

The ordering ensures a callback is never switched to a route that rejects it
before its secret/key is present, while the atomic claim prevents retries from
creating duplicate pod messages during the transition.

Provider references: [Slack request signing](https://api.slack.com/authentication/verifying-requests-with-signing-secrets), [Discord interactions verification](https://docs.discord.com/developers/interactions/overview), and [GroupMe callbacks](https://dev.groupme.com/tutorials/bots).
