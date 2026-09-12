// eslint-disable-next-line global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line global-require
const { manifests } = require('../manifests');
// eslint-disable-next-line global-require
const SlackApi = require('../../services/slackApi');
// eslint-disable-next-line global-require
const { normalizeSlackMessage } = require('./slackNormalizer');
// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../normalizeBufferMessage');
// eslint-disable-next-line global-require
const { verifySlackSignature } = require('../../services/webhookVerificationService');

interface SlackProvider {
  validateConfig(): Promise<void>;
  getWebhookHandlers(): Record<string, (req: unknown, res: unknown) => unknown>;
  ingestEvent(payload: unknown): Promise<unknown[]>;
  syncRecent(opts?: { hours?: number }): Promise<unknown>;
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

function createSlackProvider(integration: { _id: unknown; config?: Record<string, unknown>; [key: string]: unknown }): SlackProvider {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      validateRequiredConfig(config, manifests.slack);
    },

    // @ts-ignore — handler param types are more specific than generic interface allows
    getWebhookHandlers() {
      return {
        verify: (_req: unknown, res: { sendStatus: (n: number) => unknown }) => res.sendStatus(200),
        events: async (req: { headers: Record<string, string>; body: Record<string, unknown>; rawBody?: string }, res: { status: (n: number) => { send: (s: unknown) => unknown }; sendStatus: (n: number) => unknown }) => {
          const ts = req.headers['x-slack-request-timestamp'];
          const sig = req.headers['x-slack-signature'];
          const raw = req.rawBody || JSON.stringify(req.body || {});
          if (!verifySlackSignature({
            signingSecret: config.signingSecret,
            timestamp: ts,
            signature: sig,
            rawBody: raw,
          })) {
            return res.status(401).send('invalid signature');
          }
          if (req.body?.type === 'url_verification') {
            return res.status(200).send(req.body.challenge);
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
                    $slice: -1 * ((config.maxBufferSize as number) || 1000),
                  },
                },
              });
            } catch (err) {
              const e = err as { message?: string };
              console.warn('slack buffer update failed', e.message);
            }
          }

          return res.sendStatus(200);
        },
      };
    },

    async ingestEvent(payload: unknown): Promise<unknown[]> {
      const p = payload as { event?: unknown } | null;
      if (!p?.event) return [];
      const normalized = normalizeSlackMessage(p.event);
      return normalized ? [normalized] : [];
    },

    async syncRecent({ hours = 1 } = {}): Promise<unknown> {
      const api = new SlackApi(config.botToken as string);
      const oldest = `${(Date.now() - hours * 3600 * 1000) / 1000}`;
      const hist = await api.history(config.channelId as string, oldest, undefined, 200) as { messages?: unknown[] };
      const messages = (hist.messages || [])
        .map(normalizeSlackMessage)
        .filter(Boolean)
        .reverse();
      return {
        success: true,
        messageCount: messages.length,
        messages,
        content: `Fetched ${messages.length} messages`,
      };
    },

    async health(): Promise<{ ok: boolean; error?: string }> {
      return { ok: !!config.botToken && !!config.channelId };
    },
  };
}

module.exports = createSlackProvider;
// LEGACY: in-platform provider. External service will replace this module.
