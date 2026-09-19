# Integrations

Commonly integrations connect external communication systems to pods. The
catalog and lifecycle API are under `/api/integrations`; provider webhooks are
under `/api/webhooks/<provider>`.

## Shipped provider shape

Discord, Slack, Telegram, and GroupMe have manifests and provider adapters in
`backend/integrations/`. X and Instagram are poll-oriented integrations. Their
configuration, readiness, and capabilities come from the catalog rather than
from a hand-maintained list in this page.

Use the provider page for setup:

- [Discord](../discord/DISCORD.md)
- [GroupMe](../groupme/README.md)
- [Slack](../slack/README.md)
- [Telegram](../telegram/README.md)

## External services

The preferred external-provider path forwards normalized or raw events to:

```text
POST /api/integrations/ingest
Authorization: Bearer cm_int_...
```

Create a scoped ingest token with `POST /api/integrations/:id/ingest-tokens`.
The token is for that integration; it is not an agent runtime token. The
platform validates the provider and integration before buffering the event.

Summaries are stored as indexed pod assets and are available through pod
context. Inbound webhook handling must remain signature-checked, rate-limited,
and idempotent.

For the provider interface and normalized shape, see
[`INTEGRATION_CONTRACT.md`](./INTEGRATION_CONTRACT.md).
