// Shared integration registry for backend providers.
// Uses the open-sourceable SDK registry.

interface IntegrationDoc {
  _id: unknown;
  config?: Record<string, unknown>;
  platformIntegration?: unknown;
  [key: string]: unknown;
}

interface IntegrationProvider {
  validateConfig?: () => Promise<void>;
  getWebhookHandlers?: () => Record<string, unknown>;
  ingestEvent?: (payload: unknown) => Promise<unknown[]>;
  syncRecent?: (opts?: unknown) => Promise<unknown>;
  health?: () => Promise<{ ok: boolean; error?: string }>;
}

interface RegistryLike {
  providers: Map<string, (integration: IntegrationDoc) => IntegrationProvider>;
  register: (type: string, factory: (integration: IntegrationDoc) => IntegrationProvider) => void;
  get: (type: string, config: IntegrationDoc) => IntegrationProvider;
}

let registry: RegistryLike;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ registry } = require('../../packages/integration-sdk/src'));
} catch {
  class IntegrationRegistry implements RegistryLike {
    providers: Map<string, (integration: IntegrationDoc) => IntegrationProvider>;

    constructor() {
      this.providers = new Map();
    }

    register(type: string, factory: (integration: IntegrationDoc) => IntegrationProvider): void {
      this.providers.set(type, factory);
    }

    get(type: string, config: IntegrationDoc): IntegrationProvider {
      const factory = this.providers.get(type);
      if (!factory) throw new Error(`No provider registered for ${type}`);
      return factory(config);
    }
  }
  registry = new IntegrationRegistry();
}

// eslint-disable-next-line global-require
const createDiscordProvider = require('./providers/discordProvider');
// eslint-disable-next-line global-require
const createSlackProvider = require('./providers/slackProvider');
// eslint-disable-next-line global-require
const createGroupMeProvider = require('./providers/groupmeProvider');
// eslint-disable-next-line global-require
const createTelegramProvider = require('./providers/telegramProvider');
// eslint-disable-next-line global-require
const createXProvider = require('./providers/xProvider');
// eslint-disable-next-line global-require
const createInstagramProvider = require('./providers/instagramProvider');

registry.register('discord', (integration) => createDiscordProvider(integration));
registry.register('slack', (integration) => createSlackProvider(integration));
registry.register('groupme', (integration) => createGroupMeProvider(integration));
registry.register('telegram', (integration) => createTelegramProvider(integration));
registry.register('x', (integration) => createXProvider(integration));
registry.register('instagram', (integration) => createInstagramProvider(integration));

module.exports = registry;

export {};
