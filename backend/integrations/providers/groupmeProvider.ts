// eslint-disable-next-line global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../normalizeBufferMessage');
// eslint-disable-next-line global-require
const IntegrationSummaryService = require('../../services/integrationSummaryService');
// eslint-disable-next-line global-require
const AgentEventService = require('../../services/agentEventService');
// eslint-disable-next-line global-require
const groupmeService = require('../../services/groupmeService');
// eslint-disable-next-line global-require
const Summary = require('../../models/Summary');
// eslint-disable-next-line global-require
const { manifests } = require('../manifests');

interface GroupMePayload {
  system?: boolean;
  sender_type?: string;
  attachments?: Array<{ url?: string; text?: string }>;
  text?: string;
  created_at?: number;
  id?: string | number;
  user_id?: string | number;
  sender_id?: string | number;
  name?: string;
  group_id?: string | number;
  [key: string]: unknown;
}

interface NormalizedGroupMeMessage {
  source: 'groupme';
  externalId: string | undefined;
  authorId: string;
  authorName: string | undefined;
  content: string;
  timestamp: string;
  attachments: Array<{ type: string; url: string }>;
  metadata: { groupId: string | undefined };
  raw: unknown;
}

interface GroupMeProvider {
  validateConfig(): Promise<void>;
  getWebhookHandlers(): Record<string, (req: unknown, res: unknown) => unknown>;
  ingestEvent(payload: unknown): Promise<NormalizedGroupMeMessage[]>;
  syncRecent(opts?: unknown): Promise<{ success: boolean; messageCount: number; messages: unknown[]; content: string }>;
  health(): Promise<{ ok: boolean; error?: string }>;
}

let ValidationError: new (msg: string) => Error;
let validateRequiredConfig: (config: unknown, manifest: unknown) => void;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ validateRequiredConfig } = require('../../../packages/integration-sdk/src/manifest'));
} catch {
  ValidationError = class extends Error {};
  validateRequiredConfig = (config: unknown, manifest: unknown) => {
    const required = (manifest as { requiredConfig?: string[] })?.requiredConfig || [];
    const missing = required.filter((f) => !(config as Record<string, unknown>)?.[f]);
    if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
  };
}

function normalizeGroupMe(payload: unknown): NormalizedGroupMeMessage | null {
  if (!payload) return null;
  const p = payload as GroupMePayload;
  if (p.system) return null;
  if (p.sender_type === 'bot') return null;

  const attachments = (p.attachments || []).map((a) => a.url || a.text).filter(Boolean) as string[];
  const content = p.text || (attachments.length ? 'Shared an attachment' : '');
  const timestamp = p.created_at
    ? new Date(p.created_at * 1000).toISOString()
    : new Date().toISOString();

  return {
    source: 'groupme',
    externalId: p.id ? String(p.id) : undefined,
    authorId: p.user_id ? String(p.user_id) : String(p.sender_id || ''),
    authorName: p.name,
    content,
    timestamp,
    attachments: attachments.map((url) => ({ type: 'link', url })),
    metadata: {
      groupId: p.group_id ? String(p.group_id) : undefined,
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

function truncateGroupmeMessage(text: string): string {
  if (!text) return '';
  if (text.length <= MAX_GROUPME_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_GROUPME_MESSAGE_LENGTH - 1)}…`;
}

function createGroupMeProvider(integration: { _id: unknown; config?: Record<string, unknown>; podId?: unknown; [key: string]: unknown }): GroupMeProvider {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      validateRequiredConfig(config, manifests.groupme);
    },

    // @ts-ignore — handler param types are more specific than generic interface allows
    getWebhookHandlers() {
      return {
        events: async (req: { body: Record<string, unknown> }, res: { status: (n: number) => { send: (s: string) => unknown }; sendStatus: (n: number) => unknown }) => {
          if (!req.body) return res.status(400).send('missing body');

          const latest = await Integration.findById(integration._id).lean() as { config?: Record<string, unknown>; podId?: unknown; _id?: unknown } | null;
          const effectiveConfig = latest?.config || config;

          if (effectiveConfig.groupId && req.body.group_id && `${req.body.group_id}` !== `${effectiveConfig.groupId}`) {
            return res.status(403).send('group mismatch');
          }
          const rawText = (req.body.text as string) || '';
          const text = rawText.replace(/^\uFEFF/, '').trim();
          const lowerText = text.toLowerCase();
          const command = lowerText.split(/\s+/)[0];
          const isSummaryCommand = /^!summary\b/i.test(text);
          const isPodCommand = /^!pod(-summary|summary)?\b/i.test(text);
          const { botId } = effectiveConfig as { botId?: string };

          if (botId && text.startsWith('!')) {
            console.log('GroupMe command received', {
              integrationId: integration._id,
              command,
              text,
              hasBotId: !!botId,
            });

            if (isSummaryCommand || command.startsWith(GROUPME_COMMANDS.SUMMARY)) {
              try {
                const buffer = (latest?.config?.messageBuffer as unknown[]) || [];
                if (!buffer.length) {
                  await groupmeService.sendMessage(botId, 'No recent GroupMe activity to summarize.');
                  return res.sendStatus(200);
                }

                const summary = await IntegrationSummaryService.createSummary(latest, buffer);
                // eslint-disable-next-line global-require
                const { AgentInstallation } = require('../../models/AgentRegistry');
                let installations: Array<{ instanceId?: string }> = [];
                try {
                  installations = await AgentInstallation.find({
                    agentName: 'commonly-bot',
                    podId: latest?.podId,
                    status: 'active',
                  }).lean();
                } catch (err) {
                  const e = err as { message?: string };
                  console.warn('groupme agent lookup failed', e.message);
                }

                const targets = installations.length > 0 ? installations : [{ instanceId: 'default' }];

                await Promise.all(
                  targets.map((installation) => (
                    AgentEventService.enqueue({
                      agentName: 'commonly-bot',
                      instanceId: installation.instanceId || 'default',
                      podId: latest?.podId,
                      type: 'integration.summary',
                      payload: {
                        summary,
                        integrationId: latest?._id?.toString(),
                        source: 'groupme',
                      },
                    })
                  )),
                );

                await Integration.findByIdAndUpdate(integration._id, {
                  'config.messageBuffer': [],
                  'config.lastSummaryAt': new Date(),
                });
                await groupmeService.sendMessage(botId, '✅ Queued GroupMe summary for Commonly Bot.');
              } catch (err) {
                const e = err as { message?: string };
                console.warn('groupme summary command failed', e.message);
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
                  .lean() as { title?: string; content?: string } | null;

                if (!latestSummary) {
                  await groupmeService.sendMessage(botId, '📝 No recent pod summaries available yet.');
                  return res.sendStatus(200);
                }

                const title = latestSummary.title || 'Pod Summary';
                const summaryText = `${title}\n\n${latestSummary.content}`;
                await groupmeService.sendMessage(botId, truncateGroupmeMessage(summaryText));
              } catch (err) {
                const e = err as { message?: string };
                console.warn('groupme pod summary command failed', e.message);
              }
              return res.sendStatus(200);
            }
          }

          const normalized = normalizeGroupMe(req.body);
          const bufferMessage = normalizeBufferMessage(normalized);
          if (!bufferMessage) return res.sendStatus(200);

          try {
            await Integration.findByIdAndUpdate(integration._id, {
              $push: {
                'config.messageBuffer': {
                  $each: [bufferMessage],
                  $slice: -1 * ((effectiveConfig.maxBufferSize as number) || 1000),
                },
              },
            });
          } catch (err) {
            const e = err as { message?: string };
            console.warn('groupme buffer update failed', e.message);
          }

          return res.sendStatus(200);
        },
      };
    },

    async ingestEvent(payload: unknown): Promise<NormalizedGroupMeMessage[]> {
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

export {};
