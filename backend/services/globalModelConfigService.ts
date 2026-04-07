import SystemSetting from '../models/SystemSetting';

const MODEL_CONFIG_KEY = 'llm.globalModelConfig';

export interface OpenRouterServiceConfig {
  baseUrl: string;
  model: string;
}

export interface LlmServiceConfig {
  provider: string;
  model: string;
  contextLimit: number;
  openrouter: OpenRouterServiceConfig;
}

export interface CommunityAgentModel {
  primary: string;
  fallbacks: string[];
}

export interface OpenClawConfig {
  provider: string;
  model: string;
  fallbackModels: string[];
  devAgentIds: string[];
  communityAgentModel: CommunityAgentModel;
}

export interface GlobalModelConfig {
  llmService: LlmServiceConfig;
  openclaw: OpenClawConfig;
}

const DEFAULT_CONFIG: GlobalModelConfig = {
  llmService: {
    provider: 'auto', // auto | gemini | litellm | openrouter
    model: 'gemini-2.5-flash',
    contextLimit: 128000, // max input tokens for the configured model
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: '',
    },
  },
  openclaw: {
    provider: 'google', // google | openrouter | openai | anthropic | custom
    model: 'google/gemini-2.5-flash',
    fallbackModels: [
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash-lite',
      'google/gemini-2.0-flash',
    ],
    // Agent IDs that use Codex as primary. All others use communityAgentModel as primary.
    devAgentIds: ['theo', 'nova', 'pixel', 'ops'],
    // Model used by non-dev agents (community agents like liz/tarik/tom/fakesam/x-curator).
    communityAgentModel: {
      primary: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      fallbacks: ['openrouter/arcee-ai/trinity-large-preview:free'],
    },
  },
};

const CACHE_TTL_MS = 15000;
let cachedConfig: GlobalModelConfig | null = null;
let cachedAt = 0;

const normalizeProvider = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['auto', 'gemini', 'litellm', 'openrouter', 'openai', 'anthropic'].includes(normalized)) {
    return normalized;
  }
  return DEFAULT_CONFIG.llmService.provider;
};

const normalizeOpenClawProvider = (value: unknown): string => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['google', 'openrouter', 'openai', 'anthropic', 'openai-codex', 'custom'].includes(normalized)) {
    return normalized;
  }
  return DEFAULT_CONFIG.openclaw.provider;
};

const normalizeModel = (value: unknown, fallback = ''): string => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const normalizeOpenClawModel = ({ provider, model, fallback }: { provider: string; model: unknown; fallback: string }): string => {
  const resolved = normalizeModel(model, fallback);
  if (!resolved) return fallback;
  if (provider === 'custom') return resolved;
  if (provider === 'openrouter') {
    if (resolved.startsWith('openrouter/')) return resolved;
    if (resolved.startsWith('openrouter:')) {
      return `openrouter/${resolved.slice('openrouter:'.length)}`;
    }
    return `openrouter/${resolved}`;
  }
  if (provider === 'openai-codex') {
    if (resolved.startsWith('openai-codex/')) return resolved;
    return `openai-codex/${resolved}`;
  }
  if (resolved.includes('/')) return resolved;
  return `${provider}/${resolved}`;
};

const normalizeDevAgentIds = (value: unknown): string[] => {
  let list: unknown[] = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string') {
    list = value.split(',');
  }
  return Array.from(
    new Set(list.map((id) => String(id || '').trim().toLowerCase()).filter(Boolean)),
  );
};

const normalizeFallbackModels = (value: unknown, fallback: string[] = DEFAULT_CONFIG.openclaw.fallbackModels): string[] => {
  let list: unknown[] = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string') {
    list = value.split(',');
  }
  const normalized = Array.from(
    new Set(
      list
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
    ),
  );
  if (normalized.length) return normalized;
  return [...fallback];
};

const normalizeCommunityAgentModel = (value: unknown): CommunityAgentModel => {
  const defaultVal = DEFAULT_CONFIG.openclaw.communityAgentModel;
  if (!value || typeof value !== 'object') return { ...defaultVal };
  const v = value as Partial<CommunityAgentModel>;
  const primary = normalizeModel(v.primary, defaultVal.primary);
  const fallbacks = normalizeFallbackModels(v.fallbacks, defaultVal.fallbacks);
  return { primary, fallbacks };
};

const normalizeContextLimit = (value: unknown): number => {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1024) return DEFAULT_CONFIG.llmService.contextLimit;
  return Math.min(parsed, 2000000);
};

const sanitize = (candidate: Partial<GlobalModelConfig> = {}): GlobalModelConfig => {
  const llm = candidate?.llmService || ({} as Partial<LlmServiceConfig>);
  const oc = candidate?.openclaw || ({} as Partial<OpenClawConfig>);
  const next: GlobalModelConfig = {
    llmService: {
      provider: normalizeProvider(llm?.provider),
      model: normalizeModel(
        (llm as Record<string, unknown>)?.model || (llm as Record<string, unknown>)?.defaultModel,
        DEFAULT_CONFIG.llmService.model,
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
    openclaw: {
      provider: normalizeOpenClawProvider(oc?.provider),
      model: normalizeOpenClawModel({
        provider: normalizeOpenClawProvider(oc?.provider),
        model: (oc as Record<string, unknown>)?.model || (oc as Record<string, unknown>)?.defaultModel,
        fallback: DEFAULT_CONFIG.openclaw.model,
      }),
      fallbackModels: normalizeFallbackModels(oc?.fallbackModels),
      devAgentIds: normalizeDevAgentIds(
        oc?.devAgentIds ?? DEFAULT_CONFIG.openclaw.devAgentIds,
      ),
      communityAgentModel: normalizeCommunityAgentModel(oc?.communityAgentModel),
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

  static async getConfig({ includeSecrets = false, forceRefresh = false }: GetConfigOptions = {}): Promise<GlobalModelConfig> {
    void includeSecrets;
    if (!forceRefresh && cachedConfig && (Date.now() - cachedAt) < CACHE_TTL_MS) {
      return JSON.parse(JSON.stringify(cachedConfig));
    }
    const setting = await SystemSetting.findOne({ key: MODEL_CONFIG_KEY }).lean() as Record<string, unknown> | null;
    const stored = setting?.value && typeof setting.value === 'object' ? setting.value as Partial<GlobalModelConfig> : {};
    const defaults = GlobalModelConfigService.defaults();
    const merged = sanitize(
      {
        ...defaults,
        ...stored,
        llmService: {
          ...defaults.llmService,
          ...(stored.llmService || {}),
          openrouter: {
            ...defaults.llmService.openrouter,
            ...(stored.llmService?.openrouter || {}),
          },
        },
        openclaw: {
          ...defaults.openclaw,
          ...(stored.openclaw || {}),
        },
      },
    );
    cachedConfig = merged;
    cachedAt = Date.now();

    return JSON.parse(JSON.stringify(merged));
  }

  static async setConfig(patch: Partial<GlobalModelConfig> = {}, userId: string | null = null): Promise<GlobalModelConfig> {
    const current = await GlobalModelConfigService.getConfig({ includeSecrets: true, forceRefresh: true });
    const mergedCandidate: GlobalModelConfig = {
      ...current,
      ...(patch || {}),
      llmService: {
        ...current.llmService,
        ...((patch && patch.llmService) || {}),
        openrouter: {
          ...current.llmService.openrouter,
          ...((patch && patch.llmService && patch.llmService.openrouter) || {}),
        },
      },
      openclaw: {
        ...current.openclaw,
        ...((patch && patch.openclaw) || {}),
      },
    };

    const sanitized = sanitize(mergedCandidate);

    await SystemSetting.findOneAndUpdate(
      { key: MODEL_CONFIG_KEY },
      {
        $set: {
          value: sanitized,
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
    return GlobalModelConfigService.getConfig({ includeSecrets: false, forceRefresh: false });
  }
}

export default GlobalModelConfigService;
