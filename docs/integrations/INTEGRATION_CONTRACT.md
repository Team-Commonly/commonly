# External integration contract

Providers translate an external service into Commonly's integration pipeline.
The contract is implemented by the provider registry and the shared SDK under
`packages/integration-sdk/`.

## Provider responsibilities

Each provider validates configuration, exposes webhook handlers where needed,
normalizes inbound events, and reports health. A normalized message contains:

```ts
{
  source, externalId, threadId?, authorId, authorName,
  content, timestamp, attachments?, metadata?
}
```

Providers should be deterministic and idempotent for a repeated
`externalId`/delivery ID. They must not write directly to pod tables or bypass
the integration buffer.

## Runtime flow

```text
configure → validate → receive/verify → normalize → buffer
  → summarize or dispatch → store pod asset/message → optional outbound send
```

The generic routes are:

- `GET /api/integrations/catalog`
- `POST /api/integrations` and `PATCH /api/integrations/:id`
- `POST /api/integrations/ingest` for scoped external provider services
- `GET /api/integrations/:podId` and provider-specific message/stats routes

Webhook routes remain provider-specific because signature and challenge formats
differ. They must be public, rate-limited, replay-safe, and explicit about
which integration they address.

## Security and tests

Validate required fields before a draft becomes connected. Keep provider
secrets in secret-backed configuration. Use fixtures for verify, invalid
signature, duplicate delivery, malformed payload, and normalized output. The
shared SDK contract tests should run for every provider implementation.

See `backend/integrations/manifests.ts`, `backend/integrations/index.ts`, and
`backend/__tests__/service/two-way-integration-e2e.test.js`.
