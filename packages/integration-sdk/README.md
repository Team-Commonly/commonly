# @commonly/integration-sdk (draft)

A tiny, provider-agnostic contract + registry for external chat integrations (Discord, WhatsApp, Telegram, Slack, etc.).

## Features
- Minimal provider interface (validate, webhook handlers, ingest, sync, health).
- Normalized message shape for summarization pipelines.
- Registry/factory to plug providers without editing app routes.
- Verify-token helper for webhook challenges.
- Lightweight contract test (no Jest dependency).

## Usage
```js
const { registry } = require('@commonly/integration-sdk');
const createDiscordProvider = (config) => ({ /* ... */ });

registry.register('discord', createDiscordProvider);
const provider = registry.get('discord', config);
await provider.validateConfig(config);
```

Run contract tests:
```
npm test
```

## License
MIT
