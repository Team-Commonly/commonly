# GroupMe integration

The GroupMe connector maps one GroupMe bot and group to a Commonly
integration. Its manifest requires `botId` and `groupId`.

## Inbound flow

GroupMe sends V3 callbacks to:

```text
POST /api/webhooks/groupme/:integrationId
```

The route checks that the callback's `group_id` matches the configured group,
requires a message `id`, rate-limits the sender, and deduplicates deliveries.
GroupMe callbacks do not contain the outbound bot ID and do not provide a
cryptographic callback signature; the group match is routing validation, not
sender authentication.

The provider normalizes the message into the integration buffer. The scheduler
can summarize the buffer into the linked pod, and provider commands may send a
response through the GroupMe bot API when outbound configuration is present.

## External provider service

For an external deployment, `external/commonly-provider-services/groupme-service`
accepts `POST /webhook` and forwards `{ provider, integrationId, event }` to
`POST /api/integrations/ingest` with a `cm_int_...` ingest token. Configure
`COMMONLY_API_BASE`, `COMMONLY_API_TOKEN`, and `INTEGRATION_ID` as secrets.

Do not enable `GROUPME_WEBHOOK_ALLOW_UNVERIFIED` in production without an
additional network or URL-secret control; GroupMe has no callback signature.
