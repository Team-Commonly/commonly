const DiscordService = require('../../services/discordService');
let ValidationError;
try {
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
} catch (err) {
  ValidationError = class extends Error {};
}

function createDiscordProvider(integration) {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      try {
        await DiscordService.validateConfig(config);
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
