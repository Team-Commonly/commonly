export interface ProviderReadiness {
  available: boolean;
  /** A stable, user-safe enum; never expose configuration keys in API output. */
  reason?: 'not_configured';
}

interface IntegrationManifest {
  id: string;
  /**
   * The COMPLETENESS PREDICATE: every key a row must hold for
   * `isManifestComplete` to call it configured (`routes/integrations.ts`), which
   * is what sets a row's `status`. It names server-owned keys **by design** —
   * a bind writes `botTokenRef`/`chatId`, the environment supplies `botToken` —
   * because completeness is a fact about the row, not about who may send it.
   *
   * Do NOT "clean" this list down to the caller-supplied subset: an empty list
   * reads as complete (`getMissingRequiredFields` returns `[]`), so a connector
   * whose binding is written by a flow would be created `connected` before it is
   * bound (wren, 74255).
   *
   * The catalog publishes this list MINUS `SERVER_OWNED_CONFIG_KEYS`
   * (`catalog.ts`), so the published contract names only what a caller supplies
   * while the predicate keeps naming what the row needs (TASK-140).
   */
  requiredConfig: string[];
  configSchema: unknown;
  /** Runtime readiness for an installable provider, not legacy row config. */
  readiness?: () => ProviderReadiness;
  catalog: {
    label: string;
    provider: string;
    category: string;
    docsPath: string;
    description: string;
    capabilities: string[];
  } | null;
}

let sdk: {
  buildConfigSchema?: (fields?: string[]) => unknown;
  validateManifest?: (manifest: IntegrationManifest) => IntegrationManifest;
  catalog?: { register?: (manifest: IntegrationManifest) => void };
};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  sdk = require('../../packages/integration-sdk/src');
} catch {
  sdk = {
    buildConfigSchema: (requiredFields: string[] = []) => ({
      type: 'object',
      additionalProperties: true,
      properties: Object.fromEntries(requiredFields.map((f) => [f, { type: 'string' }])),
      required: [...requiredFields],
    }),
    validateManifest: (manifest: IntegrationManifest) => manifest,
  };
}

const { buildConfigSchema, validateManifest } = sdk as Required<typeof sdk>;

const hasConfiguration = (...keys: string[]): boolean => keys.every((key) => {
  const value = process.env[key];
  return typeof value === 'string' && value.trim().length > 0;
});

const notConfigured = (): ProviderReadiness => ({ available: false, reason: 'not_configured' });

const manifests: Record<string, IntegrationManifest> = {
  discord: validateManifest({
    id: 'discord',
    // `serverId`/`channelId` come from the consent callback (they name the guild
    // and channel the caller authorised); `botToken` is instance-wide and
    // resolved from the environment on every read, including the create-time 400
    // that keeps a tokenless instance from saving a row it will 500 on. It is in
    // the predicate for that reason and filtered out of the published payload
    // (`catalog.ts`) — a client that followed the old published list sent a key
    // the same route refuses with `server_owned_config_key` (TASK-140).
    requiredConfig: ['serverId', 'channelId', 'botToken'],
    configSchema: buildConfigSchema(['serverId', 'channelId', 'botToken']),
    catalog: {
      label: 'Discord',
      provider: 'discord',
      category: 'chat',
      docsPath: 'docs/discord/DISCORD.md',
      description: 'Ingest Discord channel activity and post pod summaries.',
      capabilities: ['webhook', 'gateway', 'summary', 'commands'],
    },
  }),
  slack: validateManifest({
    id: 'slack',
    // The predicate names WHAT THE BIND WRITES — `chatId` (the DM it opens) and
    // the opaque `botTokenRef` — because that is what a bound row holds. It used
    // to name `botToken` (retired by TASK-124) and `channelId` (which no Slack
    // writer has ever set), so a bound row failed its own completeness predicate
    // and the next config PATCH flipped it back to `pending` (wren, 74256).
    // `signingSecret` left the predicate with them, and it is not a caller field
    // at any layer: a body's copy is stripped (`SERVER_OWNED_CONFIG_KEYS`) and
    // every reader takes the instance's `SLACK_SIGNING_SECRET` (TASK-141).
    requiredConfig: ['botTokenRef', 'chatId'],
    configSchema: buildConfigSchema(['botTokenRef', 'chatId']),
    readiness: () => (
      hasConfiguration(
        'SLACK_CLIENT_ID',
        'SLACK_CLIENT_SECRET',
        'SLACK_SIGNING_SECRET',
        'CONNECTOR_SECRET_KEYS',
        'CONNECTOR_SECRET_ACTIVE_KEY',
      ) ? { available: true } : notConfigured()
    ),
    catalog: {
      label: 'Slack',
      provider: 'slack',
      category: 'chat',
      docsPath: 'docs/slack/README.md',
      description: 'Ingest Slack Events API messages into pod summaries.',
      capabilities: ['webhook', 'summary', 'commands'],
    },
  }),
  groupme: validateManifest({
    id: 'groupme',
    requiredConfig: ['botId', 'groupId'],
    configSchema: buildConfigSchema(['botId', 'groupId']),
    catalog: {
      label: 'GroupMe',
      provider: 'groupme',
      category: 'chat',
      docsPath: 'docs/groupme/README.md',
      description: 'Buffer GroupMe messages and summarize them into pods.',
      capabilities: ['webhook', 'commands', 'summary'],
    },
  }),
  telegram: validateManifest({
    id: 'telegram',
    // Nothing here is the caller's: the row is bound by the connect code the
    // create route mints (`mintConnectCode`) and the `/start` that proves the
    // chat, which is why `chatId` is stripped from a body. The predicate still
    // names it — the row is not configured until a chat is bound — while the
    // published list is empty, which is exactly the difference the filter keeps
    // (`catalog.ts`; wren 74255).
    requiredConfig: ['chatId'],
    configSchema: buildConfigSchema(['chatId']),
    readiness: () => (
      hasConfiguration('TELEGRAM_BOT_TOKEN')
        && (hasConfiguration('TELEGRAM_SECRET_TOKEN') || process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED === 'true')
        ? { available: true }
        : notConfigured()
    ),
    catalog: {
      label: 'Telegram',
      provider: 'telegram',
      category: 'chat',
      docsPath: 'docs/telegram/README.md',
      description: 'One Telegram chat, one pod.',
      capabilities: ['webhook', 'summary', 'commands'],
    },
  }),
  x: validateManifest({
    id: 'x',
    requiredConfig: ['accessToken', 'username'],
    configSchema: buildConfigSchema(['accessToken', 'username', 'userId', 'category']),
    catalog: {
      label: 'X',
      provider: 'x',
      category: 'social',
      docsPath: 'docs/x/README.md',
      description: 'Pull X posts into pods for searchable context and summaries.',
      capabilities: ['polling', 'posts', 'summary'],
    },
  }),
  instagram: validateManifest({
    id: 'instagram',
    requiredConfig: ['accessToken', 'igUserId'],
    configSchema: buildConfigSchema(['accessToken', 'igUserId', 'username', 'category']),
    catalog: {
      label: 'Instagram',
      provider: 'instagram',
      category: 'social',
      docsPath: 'docs/instagram/README.md',
      description: 'Pull Instagram posts into pods for searchable context and summaries.',
      capabilities: ['polling', 'posts', 'summary'],
    },
  }),
};

if (sdk.catalog && typeof sdk.catalog.register === 'function') {
  Object.values(manifests).forEach((manifest) => {
    try {
      sdk.catalog!.register!(manifest);
    } catch {
      // Ignore catalog registration errors
    }
  });
}

module.exports = { manifests };

export {};
