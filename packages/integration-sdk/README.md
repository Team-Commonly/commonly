# @commonly/integration-sdk (draft)

A tiny, provider-agnostic contract + registry for external chat integrations (Discord, WhatsApp, Telegram, Slack, etc.).

## Features
- Minimal provider interface (validate, webhook handlers, ingest, sync, health).
- Normalized message shape for summarization pipelines.
- Registry/factory to plug providers without editing app routes.
- Verify-token helper for webhook challenges.
- Manifest helpers for required config fields and lightweight config schemas.
- Catalog registry for integration metadata that can drive UI/docs.
- Lightweight contract test (no Jest dependency).

## Usage
```js
const { registry } = require('@commonly/integration-sdk');
const createDiscordProvider = (config) => ({ /* ... */ });

registry.register('discord', createDiscordProvider);
const provider = registry.get('discord', config);
await provider.validateConfig(config);
```

Manifests and catalog entries:
```js
const { buildConfigSchema, validateManifest, catalog } = require('@commonly/integration-sdk');

const slackManifest = validateManifest({
  id: 'slack',
  requiredConfig: ['botToken', 'signingSecret', 'channelId'],
  configSchema: buildConfigSchema(['botToken', 'signingSecret', 'channelId']),
  catalog: { label: 'Slack', category: 'chat' },
});

catalog.register(slackManifest);
```

Run contract tests:
```
npm test
```

## License
MIT
