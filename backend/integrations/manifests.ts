export interface ProviderReadiness {
  available: boolean;
  /** A stable, user-safe enum; never expose configuration keys in API output. */
  reason?: 'not_configured';
}

interface IntegrationManifest {
  id: string;
  /** What a CALLER supplies. Published verbatim in the catalog (`catalog.ts`). */
  requiredConfig: string[];
  /**
   * What the SERVER supplies: an environment credential it resolves on every
   * read, or a value a bind writes. Validated like `requiredConfig` (so a row's
   * `status` still means "this connector is configured") but never published —
   * a caller cannot set one, and `SERVER_OWNED_CONFIG_KEYS` strips it from a
   * request body before it reaches this check.
   */
  serverOwnedConfig: string[];
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
    // and channel the caller authorised); the bot token is instance-wide and
    // resolved from the environment, and the channel webhook URL is created by
    // the connect route. Publishing `botToken` here told a client to send a key
    // the same route refuses with `server_owned_config_key` (TASK-140).
    requiredConfig: ['serverId', 'channelId'],
    serverOwnedConfig: ['botToken'],
    configSchema: buildConfigSchema(['serverId', 'channelId']),
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
    // A caller may supply the legacy channel shape (`signingSecret` + a channel
    // id, both read with an env fallback). The bot token is not the caller's:
    // the OAuth bind writes the opaque `botTokenRef` and the token itself is the
    // instance's `SLACK_BOT_TOKEN`.
    requiredConfig: ['signingSecret', 'channelId'],
    serverOwnedConfig: ['botTokenRef'],
    configSchema: buildConfigSchema(['signingSecret', 'channelId']),
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
    serverOwnedConfig: [],
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
    // chat, which is why `chatId` is server-owned and stripped from a body. It
    // used to be published — the same defect as Discord's `botToken`, found by
    // the invariant test rather than by grep (TASK-140).
    requiredConfig: [],
    serverOwnedConfig: ['chatId'],
    configSchema: buildConfigSchema([]),
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
    serverOwnedConfig: [],
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
    serverOwnedConfig: [],
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

/**
 * The union the SERVER checks: a caller's fields plus the ones it resolves or a
 * bind writes. The SDK validator and every provider read only `requiredConfig`,
 * so they are handed this derived manifest — otherwise the split above would
 * quietly drop half of what used to be validated (TASK-140). The catalog
 * publishes `requiredConfig` alone, and never this.
 */
const manifestForValidation = (manifest: IntegrationManifest): IntegrationManifest => ({
  ...manifest,
  requiredConfig: [...manifest.requiredConfig, ...(manifest.serverOwnedConfig || [])],
});

module.exports = { manifests, manifestForValidation };

export {};
