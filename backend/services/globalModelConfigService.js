const SystemSetting = require('../models/SystemSetting');

const MODEL_CONFIG_KEY = 'llm.globalModelConfig';

const DEFAULT_CONFIG = {
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
      'google/gemini-2.5-flash-lite',
      'google/gemini-2.0-flash',
    ],
  },
};

const CACHE_TTL_MS = 15000;
let cachedConfig = null;
let cachedAt = 0;

const normalizeProvider = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['auto', 'gemini', 'litellm', 'openrouter'].includes(normalized)) {
    return normalized;
  }
  return DEFAULT_CONFIG.llmService.provider;
};

const normalizeOpenClawProvider = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (['google', 'openrouter', 'openai', 'anthropic', 'openai-codex', 'custom'].includes(normalized)) {
    return normalized;
  }
  return DEFAULT_CONFIG.openclaw.provider;
};

const normalizeModel = (value, fallback = '') => {
  const normalized = String(value || '').trim();
  return normalized || fallback;
};

const normalizeOpenClawModel = ({ provider, model, fallback }) => {
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

const normalizeFallbackModels = (value, fallback = DEFAULT_CONFIG.openclaw.fallbackModels) => {
  let list = [];
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

const normalizeContextLimit = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1024) return DEFAULT_CONFIG.llmService.contextLimit;
  return Math.min(parsed, 2000000);
};

const sanitize = (candidate = {}) => {
  const next = {
    llmService: {
      provider: normalizeProvider(candidate?.llmService?.provider),
      model: normalizeModel(
        candidate?.llmService?.model || candidate?.llmService?.defaultModel,
        DEFAULT_CONFIG.llmService.model,
      ),
      contextLimit: normalizeContextLimit(candidate?.llmService?.contextLimit),
      openrouter: {
        baseUrl: normalizeModel(
          candidate?.llmService?.openrouter?.baseUrl,
          DEFAULT_CONFIG.llmService.openrouter.baseUrl,
        ),
        model: normalizeModel(candidate?.llmService?.openrouter?.model),
      },
    },
    openclaw: {
      provider: normalizeOpenClawProvider(candidate?.openclaw?.provider),
      model: normalizeOpenClawModel({
        provider: normalizeOpenClawProvider(candidate?.openclaw?.provider),
        model: candidate?.openclaw?.model || candidate?.openclaw?.defaultModel,
        fallback: DEFAULT_CONFIG.openclaw.model,
      }),
      fallbackModels: normalizeFallbackModels(candidate?.openclaw?.fallbackModels),
    },
  };
  return next;
};

class GlobalModelConfigService {
  static defaults() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  static resetCache() {
    cachedConfig = null;
    cachedAt = 0;
  }

  static async getConfig({ includeSecrets = false, forceRefresh = false } = {}) {
    void includeSecrets;
    if (!forceRefresh && cachedConfig && (Date.now() - cachedAt) < CACHE_TTL_MS) {
      return JSON.parse(JSON.stringify(cachedConfig));
    }
    const setting = await SystemSetting.findOne({ key: MODEL_CONFIG_KEY }).lean();
    const stored = setting?.value && typeof setting.value === 'object' ? setting.value : {};
    const merged = sanitize(
      {
        ...GlobalModelConfigService.defaults(),
        ...stored,
        llmService: {
          ...GlobalModelConfigService.defaults().llmService,
          ...(stored.llmService || {}),
          openrouter: {
            ...GlobalModelConfigService.defaults().llmService.openrouter,
            ...(stored.llmService?.openrouter || {}),
          },
        },
        openclaw: {
          ...GlobalModelConfigService.defaults().openclaw,
          ...(stored.openclaw || {}),
        },
      },
    );
    cachedConfig = merged;
    cachedAt = Date.now();

    return JSON.parse(JSON.stringify(merged));
  }

  static async setConfig(patch = {}, userId = null) {
    const current = await GlobalModelConfigService.getConfig({ includeSecrets: true, forceRefresh: true });
    const mergedCandidate = {
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

module.exports = GlobalModelConfigService;
