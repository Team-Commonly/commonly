const Integration = require('../../models/Integration');
let ValidationError;
try {
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
} catch (err) {
  ValidationError = class extends Error {};
}

function normalizeGroupMe(payload) {
  if (!payload || payload.system) return null; // skip system messages
  if (payload.sender_type === 'bot') return null; // avoid bot loops

  return {
    messageId: payload.id,
    authorId: payload.user_id || payload.sender_id,
    authorName: payload.name,
    content: payload.text || '',
    timestamp: payload.created_at ? new Date(payload.created_at * 1000) : new Date(),
    attachments: (payload.attachments || []).map((a) => a.url || a.text).filter(Boolean),
    raw: payload,
  };
}

function createGroupMeProvider(integration) {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      const required = ['botId', 'groupId'];
      const missing = required.filter((f) => !config[f]);
      if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
    },

    getWebhookHandlers() {
      return {
        events: async (req, res) => {
          if (!req.body) return res.status(400).send('missing body');
          if (config.groupId && req.body.group_id && `${req.body.group_id}` !== `${config.groupId}`) {
            return res.status(403).send('group mismatch');
          }
          const normalized = normalizeGroupMe(req.body);
          if (!normalized) return res.sendStatus(200);

          // Append to buffer (best-effort)
          try {
            await Integration.findByIdAndUpdate(integration._id, {
              $push: {
                'config.messageBuffer': {
                  $each: [normalized],
                  $slice: -1 * (config.maxBufferSize || 1000),
                },
              },
            });
          } catch (err) {
            console.warn('groupme buffer update failed', err.message);
          }

          return res.sendStatus(200);
        },
      };
    },

    async ingestEvent(payload) {
      const normalized = normalizeGroupMe(payload);
      return normalized ? [normalized] : [];
    },

    async health() {
      return { ok: true };
    },
  };
}

module.exports = createGroupMeProvider;
