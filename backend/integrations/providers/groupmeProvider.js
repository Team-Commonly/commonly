const Integration = require('../../models/Integration');
const { normalizeBufferMessage } = require('../normalizeBufferMessage');
const IntegrationSummaryService = require('../../services/integrationSummaryService');
const AgentEventService = require('../../services/agentEventService');
const groupmeService = require('../../services/groupmeService');
const Summary = require('../../models/Summary');
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

function normalizeGroupMe(payload) {
  if (!payload || payload.system) return null; // skip system messages
  if (payload.sender_type === 'bot') return null; // avoid bot loops

  const attachments = (payload.attachments || []).map((a) => a.url || a.text).filter(Boolean);
  const content = payload.text || (attachments.length ? 'Shared an attachment' : '');
  const timestamp = payload.created_at
    ? new Date(payload.created_at * 1000).toISOString()
    : new Date().toISOString();

  return {
    source: 'groupme',
    externalId: payload.id ? String(payload.id) : undefined,
    authorId: payload.user_id ? String(payload.user_id) : String(payload.sender_id || ''),
    authorName: payload.name,
    content,
    timestamp,
    attachments: attachments.map((url) => ({ type: 'link', url })),
    metadata: {
      groupId: payload.group_id ? String(payload.group_id) : undefined,
    },
    raw: payload,
  };
}

const GROUPME_COMMANDS = {
  SUMMARY: '!summary',
  POD_SUMMARY: '!pod-summary',
  POD: '!pod',
  PODSUMMARY: '!podsummary',
};

const MAX_GROUPME_MESSAGE_LENGTH = 900;

function truncateGroupmeMessage(text) {
  if (!text) return '';
  if (text.length <= MAX_GROUPME_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_GROUPME_MESSAGE_LENGTH - 1)}…`;
}

function createGroupMeProvider(integration) {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      validateRequiredConfig(config, manifests.groupme);
    },

    getWebhookHandlers() {
      return {
        events: async (req, res) => {
          if (!req.body) return res.status(400).send('missing body');

          const latest = await Integration.findById(integration._id).lean();
          const effectiveConfig = latest?.config || config;

          if (effectiveConfig.groupId && req.body.group_id && `${req.body.group_id}` !== `${effectiveConfig.groupId}`) {
            return res.status(403).send('group mismatch');
          }
          const rawText = req.body.text || '';
          const text = rawText.replace(/^\uFEFF/, '').trim();
          const lowerText = text.toLowerCase();
          const command = lowerText.split(/\s+/)[0];
          const isSummaryCommand = /^!summary\b/i.test(text);
          const isPodCommand = /^!pod(-summary|summary)?\b/i.test(text);
          const { botId } = effectiveConfig;

          if (botId && text.startsWith('!')) {
            console.log('GroupMe command received', {
              integrationId: integration._id,
              command,
              text,
              hasBotId: !!botId,
            });

            if (isSummaryCommand || command.startsWith(GROUPME_COMMANDS.SUMMARY)) {
              try {
                const buffer = latest?.config?.messageBuffer || [];
                if (!buffer.length) {
                  await groupmeService.sendMessage(botId, 'No recent GroupMe activity to summarize.');
                  return res.sendStatus(200);
                }

                const summary = await IntegrationSummaryService.createSummary(
                  latest,
                  buffer,
                );
                await AgentEventService.enqueue({
                  agentName: 'commonly-bot',
                  podId: latest.podId,
                  type: 'integration.summary',
                  payload: {
                    summary,
                    integrationId: latest._id.toString(),
                    source: 'groupme',
                  },
                });

                await Integration.findByIdAndUpdate(integration._id, {
                  'config.messageBuffer': [],
                  'config.lastSummaryAt': new Date(),
                });
                await groupmeService.sendMessage(
                  botId,
                  '✅ Queued GroupMe summary for Commonly Bot.',
                );
              } catch (err) {
                console.warn('groupme summary command failed', err.message);
              }
              return res.sendStatus(200);
            }

            if (
              isPodCommand
              || command.startsWith(GROUPME_COMMANDS.POD_SUMMARY)
              || command.startsWith(GROUPME_COMMANDS.PODSUMMARY)
              || command === GROUPME_COMMANDS.POD
            ) {
              try {
                const latestSummary = await Summary.findOne({
                  type: 'chats',
                  podId: integration.podId,
                })
                  .sort({ createdAt: -1 })
                  .lean();

                if (!latestSummary) {
                  await groupmeService.sendMessage(
                    botId,
                    '📝 No recent pod summaries available yet.',
                  );
                  return res.sendStatus(200);
                }

                const title = latestSummary.title || 'Pod Summary';
                const summaryText = `${title}\n\n${latestSummary.content}`;
                await groupmeService.sendMessage(
                  botId,
                  truncateGroupmeMessage(summaryText),
                );
              } catch (err) {
                console.warn('groupme pod summary command failed', err.message);
              }
              return res.sendStatus(200);
            }
          }
          const normalized = normalizeGroupMe(req.body);
          const bufferMessage = normalizeBufferMessage(normalized);
          if (!bufferMessage) return res.sendStatus(200);

          // Append to buffer (best-effort)
          try {
            await Integration.findByIdAndUpdate(integration._id, {
              $push: {
                'config.messageBuffer': {
                  $each: [bufferMessage],
                  $slice: -1 * (effectiveConfig.maxBufferSize || 1000),
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

    async syncRecent() {
      return {
        success: false,
        messageCount: 0,
        messages: [],
        content: 'syncRecent not implemented for groupme',
      };
    },

    async health() {
      return { ok: true };
    },
  };
}

module.exports = createGroupMeProvider;
// LEGACY: in-platform provider. External service will replace this module.
