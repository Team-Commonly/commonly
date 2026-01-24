// Minimal example provider to illustrate the contract.
const { ValidationError } = require('../src/errors');

function mockProvider(config = {}) {
  return {
    validateConfig: async () => {
      if (!config.apiKey) throw new ValidationError('apiKey is required');
    },
    getWebhookHandlers: () => ({
      verify: (req, res) => res.status(200).send('ok'),
      events: async (req, res) => {
        res.status(200).send();
      },
    }),
    ingestEvent: async (payload) => {
      return payload.messages || [];
    },
    syncRecent: async () => [],
    health: async () => ({ ok: true }),
  };
}

module.exports = mockProvider;
