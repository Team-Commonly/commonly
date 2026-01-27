const DiscordService = require('../../services/discordService');
const { manifests } = require('../manifests');

let ValidationError;
let validateRequiredConfig;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ validateRequiredConfig } = require('../../../packages/integration-sdk/src/manifest'));
} catch (err) {
  ValidationError = class extends Error {};
  validateRequiredConfig = (config, manifest) => {
    const required = manifest?.requiredConfig || [];
    const missing = required.filter((f) => !config?.[f]);
    if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
  };
}

function buildEffectiveConfig(integration) {
  const platformConfig = integration?.platformIntegration?.toObject
    ? integration.platformIntegration.toObject()
    : integration?.platformIntegration || {};

  return {
    ...integration?.config,
    ...platformConfig,
    botToken:
      integration?.config?.botToken
      || platformConfig.botToken
      || process.env.DISCORD_BOT_TOKEN,
  };
}

function createDiscordProvider(integration) {
  const config = buildEffectiveConfig(integration);

  return {
    async validateConfig() {
      try {
        validateRequiredConfig(config, manifests.discord);

        if (config.webhookUrl) {
          await DiscordService.validateConfig(config);
        }
      } catch (err) {
        throw new ValidationError(err.message);
      }
    },

    getWebhookHandlers() {
      // Discord interaction/webhook verification is handled in routes;
      // keep minimal handlers to satisfy contract.
      return {
        verify: (req, res) => res.json({ type: 1 }),
        events: async (req, res) => {
          const service = new DiscordService(integration._id);
          await service.handleWebhook(req.body);
          res.json({ success: true });
        },
      };
    },

    async ingestEvent(payload) {
      // Delegate to DiscordService webhook handler; return empty normalized list for now.
      const service = new DiscordService(integration._id);
      await service.handleWebhook(payload);
      return [];
    },

    async syncRecent({ hours = 1 } = {}) {
      const service = new DiscordService(integration._id);
      await service.initialize();
      return service.syncRecentMessages(hours);
    },

    async health() {
      const service = new DiscordService(integration._id);
      try {
        await service.ensureClientReady();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

module.exports = createDiscordProvider;
