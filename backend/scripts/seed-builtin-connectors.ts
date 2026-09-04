// Builtin connector manifests are catalog entries, not auto-installs. The
// seeder makes Telegram available at boot but never creates an installation or
// bearer connect code until a user explicitly chooses "Add a channel".

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { manifests } = require('../integrations/manifests');

const telegramCatalog = manifests.telegram?.catalog;
if (!telegramCatalog) {
  throw new Error('Telegram provider manifest is missing its catalog metadata');
}

const TELEGRAM_CONNECTOR = {
  installableId: 'telegram',
  // The provider registry owns catalog display copy. The Installable is the
  // package wrapper, so it must not fork a second source of truth.
  name: telegramCatalog.label,
  description: telegramCatalog.description,
  version: '1.0.0',
  kind: 'app',
  source: 'builtin',
  scope: 'user',
  status: 'active',
  requires: ['chat:read', 'chat:write', 'integrations:manage'],
  components: [
    {
      name: 'telegram-webhook',
      type: 'webhook',
      webhookPath: '/api/webhooks/telegram',
      webhookEvents: ['message', 'edited_message'],
      addresses: [{ mode: 'webhook', identifier: '/api/webhooks/telegram' }],
      scopes: ['chat:write'],
    },
    {
      name: 'telegram-relay',
      type: 'event-handler',
      eventType: 'chat.message',
      eventHandler: 'internal:telegram.relay',
      addresses: [{ mode: 'event', identifier: 'chat.message' }],
      scopes: ['chat:read'],
    },
  ],
};

const slackCatalog = manifests.slack?.catalog;
if (!slackCatalog) {
  throw new Error('Slack provider manifest is missing its catalog metadata');
}

const SLACK_CONNECTOR = {
  installableId: 'slack',
  name: slackCatalog.label,
  description: 'Link your Slack DM to Commonly — every pod you\'re in gets a voice where you already talk.',
  version: '1.0.0',
  kind: 'app',
  source: 'builtin',
  scope: 'user',
  status: 'active',
  requires: ['chat:read', 'chat:write', 'integrations:manage'],
  components: [
    {
      name: 'slack-webhook',
      type: 'webhook',
      webhookPath: '/api/webhooks/slack',
      webhookEvents: ['message.im', 'oauth.callback', 'command'],
      addresses: [{ mode: 'webhook', identifier: '/api/webhooks/slack' }],
      scopes: ['chat:write'],
    },
    {
      name: 'slack-relay',
      type: 'event-handler',
      eventType: 'chat.message',
      eventHandler: 'internal:slack.relay',
      addresses: [{ mode: 'event', identifier: 'chat.message' }],
      scopes: ['chat:read'],
    },
  ],
};

const migrateInstallationIndex = async (): Promise<void> => {
  // The scaffolding index was unique across historical uninstalls. D17 makes
  // a new installation a new projection, so replace it exactly once with the
  // partial live-state index declared on the model.
  const indexes = await InstallableInstallation.collection.indexes();
  const legacy = indexes.find((index: { name?: string; partialFilterExpression?: unknown }) => (
    index.name === 'installableId_1_targetType_1_targetId_1'
    && !index.partialFilterExpression
  ));
  if (legacy?.name) {
    await InstallableInstallation.collection.dropIndex(legacy.name);
    console.log('[builtin-connectors] replaced legacy installation uniqueness index');
  }
  await InstallableInstallation.syncIndexes();
};

export const seedBuiltinConnectors = async (): Promise<void> => {
  try {
    await migrateInstallationIndex();
    await Promise.all([TELEGRAM_CONNECTOR, SLACK_CONNECTOR].map((connector) => (
      Installable.findOneAndUpdate(
        { installableId: connector.installableId },
        {
          $set: connector,
          $setOnInsert: {
            stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
    )));
    console.log('[builtin-connectors] Telegram and Slack manifests ready');
  } catch (error) {
    console.error('[builtin-connectors] seed failed:', (error as Error).message);
  }
};

export { TELEGRAM_CONNECTOR, SLACK_CONNECTOR };

module.exports = { seedBuiltinConnectors, TELEGRAM_CONNECTOR, SLACK_CONNECTOR };
