const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const GlobalModelConfigService = require('./globalModelConfigService');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 120000;

let geminiClient = null;
let geminiModel = null;
let geminiModelName = null;

const getGeminiModel = (modelName) => {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required for Gemini requests');
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  if (!geminiModel || geminiModelName !== modelName) {
    geminiModelName = modelName;
    geminiModel = geminiClient.getGenerativeModel({ model: modelName });
  }
  return geminiModel;
};

const getLiteLLMConfig = () => {
  const baseUrl = process.env.LITELLM_BASE_URL;
  if (!baseUrl) return null;
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
  if (!apiKey) {
    throw new Error('LITELLM_API_KEY or LITELLM_MASTER_KEY is required');
  }
  const model = process.env.LITELLM_CHAT_MODEL || DEFAULT_MODEL;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model,
  };
};

const getOpenRouterConfig = (globalConfig = null) => {
  const settings = globalConfig || {};
  const openrouterSettings = settings?.llmService?.openrouter || {};
  const baseUrl = String(
    openrouterSettings.baseUrl
    || process.env.OPENROUTER_BASE_URL
    || DEFAULT_OPENROUTER_BASE_URL,
  ).trim().replace(/\/$/, '');
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const model = String(
    openrouterSettings.model
    || settings?.llmService?.model
    || settings?.llmService?.defaultModel
    || process.env.OPENROUTER_MODEL
    || DEFAULT_MODEL,
  ).trim();
  if (!apiKey) {
    throw new Error('OpenRouter API key is required');
  }
  return {
    baseUrl,
    apiKey,
    model,
  };
};

const parseLiteLLMResponse = (data) => {
  // Check for OpenRouter/LiteLLM error payloads first
  if (data?.error) {
    const errMsg = data.error.message || data.error.type || 'Unknown provider error';
    const errCode = data.error.code || data.error.status || '';
    const err = new Error(`LLM provider error: ${errMsg}`);
    err.providerCode = errCode;
    err.providerType = data.error.type || '';
    throw err;
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content || choice?.text;
  if (!content) {
    throw new Error('LLM response missing content');
  }
  return String(content).trim();
};

const generateViaLiteLLM = async (prompt, options = {}) => {
  const config = getLiteLLMConfig();
  if (!config) {
    throw new Error('LiteLLM base URL not configured');
  }
  const response = await axios.post(
    `${config.baseUrl}/chat/completions`,
    {
      model: options.model || config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: options.timeout || DEFAULT_LLM_TIMEOUT_MS,
    },
  );
  return parseLiteLLMResponse(response.data);
};

const generateViaGemini = async (prompt, options = {}) => {
  const modelName = options.model || DEFAULT_MODEL;
  const model = getGeminiModel(modelName);
  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
};

const parseOpenRouterModel = (modelName) => {
  const normalized = String(modelName || '').trim();
  if (!normalized) return '';
  if (normalized.startsWith('openrouter/')) {
    return normalized.slice('openrouter/'.length);
  }
  if (normalized.startsWith('openrouter:')) {
    return normalized.slice('openrouter:'.length);
  }
  return normalized;
};

const stripProviderPrefix = (modelName) => {
  const stripped = parseOpenRouterModel(modelName);
  // Also strip provider org prefixes like "anthropic/claude-3" -> not valid for Gemini
  // If it contains a slash and doesn't start with "gemini", it's not a Gemini model
  if (stripped.includes('/') && !stripped.startsWith('gemini')) {
    return DEFAULT_MODEL;
  }
  return stripped || DEFAULT_MODEL;
};

const generateViaOpenRouter = async (prompt, options = {}, globalConfig = null) => {
  const config = getOpenRouterConfig(globalConfig);
  const selectedModel = parseOpenRouterModel(options.model || config.model);
  const response = await axios.post(
    `${config.baseUrl}/chat/completions`,
    {
      model: selectedModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || process.env.FRONTEND_URL || 'https://commonly.me',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'Commonly',
      },
      timeout: options.timeout || DEFAULT_LLM_TIMEOUT_MS,
    },
  );
  return parseLiteLLMResponse(response.data);
};

const generateText = async (prompt, options = {}) => {
  const globalModelConfig = await GlobalModelConfigService.getConfig({
    includeSecrets: true,
  }).catch((configErr) => {
    console.warn('[llm-service] Failed to load model config, using defaults:', configErr.message);
    return null;
  });
  const configuredProvider = String(globalModelConfig?.llmService?.provider || 'auto').toLowerCase();
  const configuredModel = String(
    globalModelConfig?.llmService?.model
    || globalModelConfig?.llmService?.defaultModel
    || '',
  ).trim();
  const selectedModel = options.model || configuredModel || DEFAULT_MODEL;
  const runOptions = {
    ...options,
    model: selectedModel,
  };

  const shouldUseOpenRouter = configuredProvider === 'openrouter'
    || String(selectedModel).startsWith('openrouter/')
    || String(selectedModel).startsWith('openrouter:');
  if (shouldUseOpenRouter) {
    try {
      return await generateViaOpenRouter(prompt, runOptions, globalModelConfig);
    } catch (error) {
      console.warn(
        `[llm-service] OpenRouter failed (model=${selectedModel}): ${error.message}${error.providerCode ? ` [code=${error.providerCode}]` : ''}`,
      );
      if (process.env.GEMINI_API_KEY) {
        const geminiOptions = { ...runOptions, model: stripProviderPrefix(selectedModel) };
        console.warn(`[llm-service] Falling back to Gemini (model=${geminiOptions.model})`);
        return generateViaGemini(prompt, geminiOptions);
      }
      throw error;
    }
  }

  if (configuredProvider === 'gemini') {
    return generateViaGemini(prompt, runOptions);
  }

  if (configuredProvider === 'litellm') {
    try {
      return await generateViaLiteLLM(prompt, runOptions);
    } catch (error) {
      console.warn(
        `[llm-service] LiteLLM failed (model=${selectedModel}): ${error.message}`,
      );
      if (process.env.GEMINI_API_KEY) {
        const geminiOptions = { ...runOptions, model: stripProviderPrefix(selectedModel) };
        console.warn(`[llm-service] Falling back to Gemini (model=${geminiOptions.model})`);
        return generateViaGemini(prompt, geminiOptions);
      }
      throw error;
    }
  }

  const litellmDisabled = String(process.env.LITELLM_DISABLED || '').toLowerCase() === 'true';
  if (!litellmDisabled && process.env.LITELLM_BASE_URL) {
    try {
      return await generateViaLiteLLM(prompt, runOptions);
    } catch (error) {
      console.warn(
        `[llm-service] LiteLLM (auto) failed (model=${selectedModel}): ${error.message}`,
      );
      if (process.env.GEMINI_API_KEY) {
        const geminiOptions = { ...runOptions, model: stripProviderPrefix(selectedModel) };
        console.warn(`[llm-service] Falling back to Gemini (model=${geminiOptions.model})`);
        return generateViaGemini(prompt, geminiOptions);
      }
      throw error;
    }
  }
  return generateViaGemini(prompt, runOptions);
};

module.exports = {
  generateText,
};
