// Shared integration registry for backend providers.
// Uses the open-sourceable SDK registry.
let registry;
try {
  // Prefer shared SDK if available (monorepo)
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ registry } = require('../../packages/integration-sdk/src'));
} catch (err) {
  // Fallback lightweight registry for docker/test contexts where packages/ isn't present
  class IntegrationRegistry {
    constructor() {
      this.providers = new Map();
    }

    register(type, factory) {
      this.providers.set(type, factory);
    }

    get(type, config) {
      const factory = this.providers.get(type);
      if (!factory) throw new Error(`No provider registered for ${type}`);
      return factory(config);
    }
  }
  registry = new IntegrationRegistry();
}

const createDiscordProvider = require('./providers/discordProvider');
const createSlackProvider = require('./providers/slackProvider');
const createGroupMeProvider = require('./providers/groupmeProvider');
const createTelegramProvider = require('./providers/telegramProvider');

// Register built-in providers here
registry.register('discord', (integration) => createDiscordProvider(integration));
registry.register('slack', (integration) => createSlackProvider(integration));
registry.register('groupme', (integration) => createGroupMeProvider(integration));
registry.register('telegram', (integration) => createTelegramProvider(integration));

module.exports = registry;
