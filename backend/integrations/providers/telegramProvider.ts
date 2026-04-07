// eslint-disable-next-line global-require
const { normalizeBufferMessage } = require('../normalizeBufferMessage');
// eslint-disable-next-line global-require
const { manifests } = require('../manifests');

interface TelegramUpdate {
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  [key: string]: unknown;
}

interface TelegramMessage {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  via_bot?: unknown;
  from?: {
    id?: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
  };
  sender_chat?: { title?: string };
  chat?: { id?: number; title?: string };
}

interface NormalizedTelegramMessage {
  source: 'telegram';
  externalId: string | undefined;
  authorId: string | undefined;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: unknown[];
  metadata: { chatId: string | undefined };
  raw: unknown;
}

interface TelegramProvider {
  validateConfig(): Promise<void>;
  getWebhookHandlers(): Record<string, (req: unknown, res: unknown) => unknown>;
  ingestEvent(payload: unknown): Promise<NormalizedTelegramMessage[]>;
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

function verifyTelegramSecret(headerToken: unknown, expectedToken: unknown): boolean {
  return !!headerToken && !!expectedToken && headerToken === expectedToken;
}

function normalizeTelegram(update: unknown): NormalizedTelegramMessage | null {
  if (!update) return null;
  const u = update as TelegramUpdate;
  const msg = u.message || u.channel_post;
  if (!msg) return null;
  if (msg.via_bot || msg.from?.is_bot) return null;

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

function createTelegramProvider(integration: { _id: unknown; config?: Record<string, unknown>; [key: string]: unknown }): TelegramProvider {
  const config = integration?.config || {};

  return {
    async validateConfig() {
      validateRequiredConfig(config, manifests.telegram);
    },

    getWebhookHandlers() {
      return {
        events: async (req: { headers: Record<string, unknown>; body: unknown }, res: { status: (n: number) => { send: (s: string) => unknown }; sendStatus: (n: number) => unknown }) => {
          if (config.secretToken) {
            const headerToken = req.headers['x-telegram-bot-api-secret-token'];
            if (!verifyTelegramSecret(headerToken, config.secretToken)) {
              return res.status(401).send('invalid secret token');
            }
          }

          const normalized = normalizeTelegram(req.body);
          const bufferMessage = normalizeBufferMessage(normalized);
          if (!bufferMessage) return res.sendStatus(200);

          try {
            // eslint-disable-next-line global-require
            const Integration = require('../../models/Integration');
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
            console.warn('telegram buffer update failed', e.message);
          }

          return res.sendStatus(200);
        },
      };
    },

    async ingestEvent(payload: unknown): Promise<NormalizedTelegramMessage[]> {
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
// LEGACY: in-platform provider. External service will replace this module.
