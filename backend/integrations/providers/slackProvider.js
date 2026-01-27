const crypto = require('crypto');
const Integration = require('../../models/Integration');
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
const SlackApi = require('../../services/slackApi');
const { normalizeSlackMessage } = require('./slackNormalizer');
const { normalizeBufferMessage } = require('../normalizeBufferMessage');

function verifySlackSignature(signingSecret, timestamp, body, signature) {
  const basestring = `v0:${timestamp}:${body}`;
  const mySig = `v0=${crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex')}`;
  if (!signature) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(mySig, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch (e) {
    return false;
  }
}

function createSlackProvider(integration) {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      validateRequiredConfig(config, manifests.slack);
    },

    getWebhookHandlers() {
      return {
        verify: (req, res) => res.sendStatus(200),
        events: async (req, res) => {
          // URL verification challenge
          if (req.body?.type === 'url_verification') {
            return res.status(200).send(req.body.challenge);
          }
          // Signature validation
          const ts = req.headers['x-slack-request-timestamp'];
          const sig = req.headers['x-slack-signature'];
          const raw = Buffer.isBuffer(req.body)
            ? req.body.toString()
            : req.rawBody || '';
          if (!verifySlackSignature(config.signingSecret, ts, raw, sig)) {
            return res.status(401).send('invalid signature');
          }
          const normalized = normalizeSlackMessage(req.body?.event);
          if (normalized && config.channelId && normalized.metadata?.channelId !== config.channelId) {
            return res.sendStatus(200);
          }

          if (normalized) {
            const bufferMessage = normalizeBufferMessage({
              messageId: normalized.externalId,
              authorId: normalized.authorId,
              authorName: normalized.authorName,
              content: normalized.content,
              timestamp: normalized.timestamp,
              attachments: normalized.attachments,
            });

            if (!bufferMessage) {
              return res.sendStatus(200);
            }

            try {
              await Integration.findByIdAndUpdate(integration._id, {
                $push: {
                  'config.messageBuffer': {
                    $each: [bufferMessage],
                    $slice: -1 * (config.maxBufferSize || 1000),
                  },
                },
              });
            } catch (err) {
              console.warn('slack buffer update failed', err.message);
            }
          }

          res.sendStatus(200);
        },
      };
    },

    async ingestEvent(payload) {
      if (!payload?.event) return [];
      const normalized = normalizeSlackMessage(payload.event);
      return normalized ? [normalized] : [];
    },

    async syncRecent({ hours = 1 } = {}) {
      const api = new SlackApi(config.botToken);
      const oldest = `${(Date.now() - hours * 3600 * 1000) / 1000}`;
      const hist = await api.history(config.channelId, oldest, undefined, 200);
      const messages = (hist.messages || [])
        .map(normalizeSlackMessage)
        .filter(Boolean)
        .reverse(); // chronological
      return {
        success: true,
        messageCount: messages.length,
        messages,
        content: `Fetched ${messages.length} messages`,
      };
    },

    async health() {
      return { ok: !!config.botToken && !!config.channelId };
    },
  };
}

module.exports = createSlackProvider;
