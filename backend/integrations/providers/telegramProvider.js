const crypto = require('crypto');
const { normalizeBufferMessage } = require('../normalizeBufferMessage');
let ValidationError;
try {
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
} catch (err) {
  ValidationError = class extends Error {};
}

function verifyTelegramSecret(headerToken, expectedToken) {
  return headerToken && expectedToken && headerToken === expectedToken;
}

function normalizeTelegram(update) {
  if (!update || !update.message) return null;
  const msg = update.message;
  if (msg.via_bot) return null; // avoid bot loops

  return {
    messageId: msg.message_id?.toString(),
    authorId: msg.from?.id?.toString(),
    authorName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() || 'Unknown',
    content: msg.text || msg.caption || '',
    timestamp: msg.date ? new Date(msg.date * 1000) : new Date(),
    attachments: [],
    raw: update,
  };
}

function createTelegramProvider(integration) {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      const required = ['botToken'];
      const missing = required.filter((f) => !config[f]);
      if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
    },

    getWebhookHandlers() {
      return {
        events: async (req, res) => {
          // Optional secret token header for verification
          if (config.secretToken) {
            const headerToken = req.headers['x-telegram-bot-api-secret-token'];
            if (!verifyTelegramSecret(headerToken, config.secretToken)) {
              return res.status(401).send('invalid secret token');
            }
          }

          const normalized = normalizeTelegram(req.body);
          const bufferMessage = normalizeBufferMessage(normalized);
          if (!bufferMessage) return res.sendStatus(200);

          // Buffer best-effort
          try {
            const Integration = require('../../models/Integration');
            await Integration.findByIdAndUpdate(integration._id, {
              $push: {
                'config.messageBuffer': {
                  $each: [bufferMessage],
                  $slice: -1 * (config.maxBufferSize || 1000),
                },
              },
            });
          } catch (err) {
            console.warn('telegram buffer update failed', err.message);
          }

          return res.sendStatus(200);
        },
      };
    },

    async ingestEvent(payload) {
      const normalized = normalizeTelegram(payload);
      return normalized ? [normalized] : [];
    },

    async health() {
      return { ok: true };
    },
  };
}

module.exports = createTelegramProvider;
