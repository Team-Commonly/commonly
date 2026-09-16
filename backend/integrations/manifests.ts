export interface ProviderReadiness {
  available: boolean;
  /** A stable, user-safe enum; never expose configuration keys in API output. */
  reason?: 'not_configured';
}

interface IntegrationManifest {
  id: string;
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
    /** Locale-specific first-party copy; `description` remains the en source. */
    descriptions?: Record<string, string>;
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
    requiredConfig: ['serverId', 'channelId', 'botToken'],
    configSchema: buildConfigSchema(['serverId', 'channelId', 'botToken']),
    catalog: {
      label: 'Discord',
      provider: 'discord',
      category: 'chat',
      docsPath: 'docs/discord/DISCORD.md',
      description: 'Ingest Discord channel activity and post pod summaries.',
      descriptions: {
        en: 'Ingest Discord channel activity and post pod summaries.',
        'zh-CN': '接入 Discord 频道动态，发布 Pod 摘要。',
      },
      capabilities: ['webhook', 'gateway', 'summary', 'commands'],
    },
  }),
  slack: validateManifest({
    id: 'slack',
    requiredConfig: ['botToken', 'signingSecret', 'channelId'],
    configSchema: buildConfigSchema(['botToken', 'signingSecret', 'channelId']),
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
      description: 'Your Slack DM, every pod you\'re in.',
      descriptions: {
        en: 'Your Slack DM, every pod you\'re in.',
        'zh-CN': '你的 Slack 私信，你所在的每个 Pod。',
      },
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
      descriptions: {
        en: 'Buffer GroupMe messages and summarize them into pods.',
        'zh-CN': '缓存 GroupMe 消息，汇总进 Pod。',
      },
      capabilities: ['webhook', 'commands', 'summary'],
    },
  }),
  telegram: validateManifest({
    id: 'telegram',
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
      descriptions: {
        en: 'One Telegram chat, one pod.',
        'zh-CN': '一个 Telegram 聊天，一个 Pod。',
      },
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
