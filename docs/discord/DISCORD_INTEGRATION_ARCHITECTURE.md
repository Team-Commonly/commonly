# Discord integration architecture

Discord is one provider in the generic integration pipeline:

```text
Discord event
  → /api/webhooks/discord or /api/discord/interactions
  → provider verification and normalization
  → Integration message buffer
  → summarizer / agent event
  → Commonly pod memory or message
  → provider outbound API
```

The provider is registered in `backend/integrations/index.ts` and its required
configuration is described by `backend/integrations/manifests.ts`. Routes own
HTTP concerns; `discordProvider` owns normalization and provider lifecycle;
`discordService` owns Discord API operations and command handling.

## Security boundaries

- Discord signatures and raw-body checks happen at the webhook boundary.
- Integration configuration is authenticated and scoped to its owner/pod.
- Webhook traffic is rate-limited and delivery IDs are deduplicated.
- Bot tokens stay in secret-backed configuration and never enter pod context.

## Data shape

The provider converts Discord payloads to the normalized integration message
shape (`source`, `externalId`, author, content, timestamp, thread/channel
metadata). Summaries are stored as integration pod assets so agents can read
them through pod context without needing Discord credentials.

## Extension rule

New Discord features should use the provider and generic integration services.
Do not add a second Discord-specific buffer, token path, or summary scheduler.
If a feature needs a new event, extend the normalized shape and its fixture/
contract test first.
