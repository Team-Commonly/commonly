const { normalizeBufferMessage } = require('../normalizeBufferMessage');
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

function verifyTelegramSecret(headerToken, expectedToken) {
  return headerToken && expectedToken && headerToken === expectedToken;
}

function normalizeTelegram(update) {
  if (!update) return null;
  const msg = update.message || update.channel_post;
  if (!msg) return null;
  if (msg.via_bot || msg.from?.is_bot) return null; // avoid bot loops

  const senderName = msg.from
    ? [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim()
    : msg.sender_chat?.title
      || msg.chat?.title
      || 'Unknown';

  const timestamp = msg.date
    ? new Date(msg.date * 1000).toISOString()
    : new Date().toISOString();

  return {
    source: 'telegram',
    externalId: msg.message_id ? String(msg.message_id) : undefined,
    authorId: msg.from?.id?.toString(),
    authorName: senderName || 'Unknown',
    content: msg.text || msg.caption || '',
    timestamp,
    attachments: [],
    metadata: {
      chatId: msg.chat?.id ? String(msg.chat.id) : undefined,
    },
    raw: update,
  };
}

function createTelegramProvider(integration) {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      validateRequiredConfig(config, manifests.telegram);
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
            // eslint-disable-next-line global-require
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

    async syncRecent() {
      return {
        success: false,
        messageCount: 0,
        messages: [],
        content: 'syncRecent not implemented for telegram',
      };
    },

    async health() {
      return { ok: true };
    },
  };
}

module.exports = createTelegramProvider;
