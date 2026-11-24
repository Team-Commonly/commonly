import SystemSetting from '../models/SystemSetting';
import { publish, subscribe } from './processBus';
import { defaultChatModel, GEMINI_DIRECT_MODEL } from '../config/agentDefaultModel';

const MODEL_CONFIG_KEY = 'llm.globalModelConfig';

interface OpenRouterServiceConfig {
  baseUrl: string;
  model: string;
}

interface LlmServiceConfig {
  provider: string;
  model: string;
  contextLimit: number;
  openrouter: OpenRouterServiceConfig;
}

export interface GlobalModelConfig {
  llmService: LlmServiceConfig;
}

// The stored row can still carry the retired OpenClaw gateway's model section
// (ADR-021). Nothing reads it; setConfig writes it back unchanged so an admin
// save never deletes it.
interface StoredModelConfig extends Partial<GlobalModelConfig> {
  openclaw?: unknown;
}

const DEFAULT_CONFIG: GlobalModelConfig = {
  llmService: {
    provider: 'auto', // auto | gemini | litellm | openrouter
    // The chart's LITELLM_CHAT_MODEL, else the agent default (F105), read when
    // asked. It was `gemini-2.5-flash`, a name LiteLLM served with DeepSeek
    // wherever Gemini was off (litellm.legacyAliases).
    get model(): string {
      return defaultChatModel();
    },
    contextLimit: 128000, // max input tokens for the configured model
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: '',
    },
  },
};

const CACHE_TTL_MS = 15000;
let cachedConfig: GlobalModelConfig | null = null;
let cachedAt = 0;
// A save drops every other process's copy (processBus); the TTL above bounds
// one that missed the message.
const CHANGED_CHANNEL = 'global-model-config-changed';
subscribe(CHANGED_CHANNEL, () => {
  cachedConfig = null;
  cachedAt = 0;
});
const LLM_SERVICE_PROVIDERS = new Set(['auto', 'gemini', 'litellm', 'openrouter']);

const normalizeProvider = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (LLM_SERVICE_PROVIDERS.has(normalized)) {
    return normalized;
  }
  if (normalized) {
    console.error(`[model-config] Unsupported persisted backend LLM provider "${normalized}"; using auto.`);
  }
  return DEFAULT_CONFIG.llmService.provider;
};

const normalizeModel = (value: unknown, fallback = ''): string => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const normalizeContextLimit = (value: unknown): number => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1024) return DEFAULT_CONFIG.llmService.contextLimit;
  return Math.min(parsed, 2000000);
};

// With no admin-persisted model, a LiteLLM-routed llmService defaults to the
// operator's LITELLM_CHAT_MODEL. Before this, the hardcoded Gemini default
// always won: values-dev set LITELLM_CHAT_MODEL=deepseek-v4-flash on 2026-09-01,
// yet every summary, digest and chat-summary call still asked for
// gemini-2.5-flash, whose key Google rejects, and fell to the template.
// A Gemini-direct provider calls Google's own API, so its default is a real
// Gemini name. The OpenRouter provider takes the operator's OPENROUTER_MODEL
// when set. Every other provider defaults to the LiteLLM name (F105).
const defaultLlmServiceModel = (provider: string): string => {
  if (provider === 'gemini') return GEMINI_DIRECT_MODEL;
  const openRouterModel = String(process.env.OPENROUTER_MODEL || '').trim();
  if (provider === 'openrouter' && openRouterModel) return openRouterModel;
  return DEFAULT_CONFIG.llmService.model;
};

const sanitize = (candidate: Partial<GlobalModelConfig> = {}): GlobalModelConfig => {
  const llm = candidate?.llmService || ({} as Partial<LlmServiceConfig>);
  const next: GlobalModelConfig = {
    llmService: {
      provider: normalizeProvider(llm?.provider),
      model: normalizeModel(
        (llm as Record<string, unknown>)?.model || (llm as Record<string, unknown>)?.defaultModel,
        defaultLlmServiceModel(normalizeProvider(llm?.provider)),
      ),
      contextLimit: normalizeContextLimit(llm?.contextLimit),
      openrouter: {
        baseUrl: normalizeModel(
          llm?.openrouter?.baseUrl,
          DEFAULT_CONFIG.llmService.openrouter.baseUrl,
        ),
        model: normalizeModel(llm?.openrouter?.model),
      },
    },
  };
  return next;
};

interface GetConfigOptions {
  includeSecrets?: boolean;
  forceRefresh?: boolean;
}

class GlobalModelConfigService {
  static defaults(): GlobalModelConfig {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  static resetCache(): void {
    cachedConfig = null;
    cachedAt = 0;
  }

  static isSupportedLlmServiceProvider(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return !normalized || LLM_SERVICE_PROVIDERS.has(normalized);
  }

  static async getConfig({ includeSecrets = false, forceRefresh = false }: GetConfigOptions = {}): Promise<GlobalModelConfig> {
    void includeSecrets;
    if (!forceRefresh && cachedConfig && (Date.now() - cachedAt) < CACHE_TTL_MS) {
      return JSON.parse(JSON.stringify(cachedConfig));
    }
    const merged = GlobalModelConfigService.resolve(await GlobalModelConfigService.readStored());
    cachedConfig = merged;
    cachedAt = Date.now();

    return JSON.parse(JSON.stringify(merged));
  }

  // The saved row as written, before defaults are merged in.
  private static async readStored(): Promise<StoredModelConfig> {
    const setting = await SystemSetting.findOne({ key: MODEL_CONFIG_KEY }).lean() as Record<string, unknown> | null;
    return setting?.value && typeof setting.value === 'object' ? setting.value as StoredModelConfig : {};
  }

  private static resolve(stored: StoredModelConfig): GlobalModelConfig {
    const defaults = GlobalModelConfigService.defaults();
    const storedLlm = (stored.llmService || {}) as Partial<LlmServiceConfig> & { defaultModel?: string };
    const merged = sanitize(
      {
        llmService: {
          ...defaults.llmService,
          ...storedLlm,
          model: storedLlm.model || storedLlm.defaultModel
            || defaultLlmServiceModel(normalizeProvider(storedLlm.provider ?? defaults.llmService.provider)),
          openrouter: {
            ...defaults.llmService.openrouter,
            ...(stored.llmService?.openrouter || {}),
          },
        },
      },
    );
    return merged;
  }

  static async setConfig(patch: Partial<GlobalModelConfig> = {}, userId: string | null = null): Promise<GlobalModelConfig> {
    if (!GlobalModelConfigService.isSupportedLlmServiceProvider(
      patch?.llmService?.provider,
    )) {
      throw new Error('Unsupported backend LLM provider. Use auto, gemini, litellm, or openrouter.');
    }
    const storedBefore = await GlobalModelConfigService.readStored();
    const current = GlobalModelConfigService.resolve(storedBefore);
    const mergedCandidate: GlobalModelConfig = {
      llmService: {
        ...current.llmService,
        ...((patch && patch.llmService) || {}),
        openrouter: {
          ...current.llmService.openrouter,
          ...((patch && patch.llmService && patch.llmService.openrouter) || {}),
        },
      },
    };

    const sanitized = sanitize(mergedCandidate);
    const stored: StoredModelConfig = JSON.parse(JSON.stringify(sanitized));
    if (storedBefore.openclaw !== undefined) stored.openclaw = storedBefore.openclaw;

    await SystemSetting.findOneAndUpdate(
      { key: MODEL_CONFIG_KEY },
      {
        $set: {
          value: stored,
          updatedBy: userId || null,
        },
      },
      {
        upsert: true,
        new: true,
      },
    );

    cachedConfig = sanitized;
    cachedAt = Date.now();
    publish(CHANGED_CHANNEL);
    return GlobalModelConfigService.getConfig({ includeSecrets: false, forceRefresh: false });
  }
}

export default GlobalModelConfigService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
