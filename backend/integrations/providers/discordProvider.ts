// eslint-disable-next-line global-require
const DiscordService = require('../../services/discordService');
// eslint-disable-next-line global-require
const { manifests, manifestForValidation } = require('../manifests');
// eslint-disable-next-line global-require
const { resolveDiscordBotToken } = require('../../utils/discordBotToken');
// eslint-disable-next-line global-require
const { resolveDiscordWebhookUrl } = require('../../utils/discordWebhookUrl');

interface IntegrationDoc {
  _id: unknown;
  config?: Record<string, unknown> & { webhookUrlRef?: string; webhookUrl?: string };
  platformIntegration?: {
    toObject?: () => Record<string, unknown>;
    botToken?: string;
    webhookUrl?: string;
    [key: string]: unknown;
  };
}

interface DiscordConfig extends Record<string, unknown> {
  botToken?: string;
  webhookUrl?: string;
}

interface DiscordProvider {
  validateConfig(): Promise<void>;
  getWebhookHandlers(): Record<string, (req: unknown, res: { json: (data: unknown) => void }) => unknown>;
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

function buildEffectiveConfig(integration: IntegrationDoc): DiscordConfig {
  const platformConfig = integration?.platformIntegration?.toObject
    ? integration.platformIntegration.toObject()
    : integration?.platformIntegration || {};

  return {
    ...integration?.config,
    ...(platformConfig as Record<string, unknown>),
    // env-first: a stored copy never wins over DISCORD_BOT_TOKEN (TASK-124).
    botToken: resolveDiscordBotToken(
      integration?.config?.botToken,
      (platformConfig as { botToken?: string }).botToken,
    ),
  };
}

function createDiscordProvider(integration: IntegrationDoc): DiscordProvider {
  const config = buildEffectiveConfig(integration);

  return {
    async validateConfig() {
      try {
        validateRequiredConfig(config, manifestForValidation(manifests.discord));
        // The URL is encrypted, so it is resolved here rather than carried in
        // `config`: on a migrated row the merged plaintext is gone and the ref
        // is the only store, and a presence check on the merged value would
        // silently skip validation altogether. Resolution can throw (an
        // unreadable key ring, a revoked ref) and the catch below turns that
        // into the ValidationError this method already speaks.
        const webhookUrl = await resolveDiscordWebhookUrl(
          integration?.config?.webhookUrlRef,
          integration?.platformIntegration?.webhookUrl,
          integration?.config?.webhookUrl,
        );
        if (webhookUrl) {
          await DiscordService.validateConfig({ ...config, webhookUrl });
        }
      } catch (err) {
        const e = err as { message?: string };
        throw new ValidationError(e.message || 'Validation failed');
      }
    },

    // @ts-ignore — handler param types are more specific than generic interface allows
    getWebhookHandlers() {
      return {
        verify: (_req: unknown, res: { json: (data: unknown) => void }) => res.json({ type: 1 }),
        events: async (req: { body: unknown }, res: { json: (data: unknown) => void }) => {
          const service = new DiscordService(integration._id);
          await service.handleWebhook(req.body);
          res.json({ success: true });
        },
      };
    },

    async ingestEvent(payload: unknown): Promise<unknown[]> {
      const service = new DiscordService(integration._id);
      await service.handleWebhook(payload);
      return [];
    },

    async syncRecent({ hours = 1 } = {}): Promise<unknown> {
      const service = new DiscordService(integration._id);
      await service.initialize();
      return service.syncRecentMessages(hours);
    },

    async health(): Promise<{ ok: boolean; error?: string }> {
      const service = new DiscordService(integration._id);
      try {
        await service.ensureClientReady();
        return { ok: true };
      } catch (err) {
        const e = err as { message?: string };
        return { ok: false, error: e.message };
      }
    },
  };
}

module.exports = createDiscordProvider;
// LEGACY: in-platform provider. External service will replace this module.

export {};
