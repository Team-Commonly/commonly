import axios from 'axios';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import GlobalModelConfigService from './globalModelConfigService';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS) || 120000;

export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface OpenRouterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LLMProviderError extends Error {
  providerCode?: string | number;
  providerType?: string;
}

let geminiClient: GoogleGenerativeAI | null = null;
let geminiModel: GenerativeModel | null = null;
let geminiModelName: string | null = null;

const getGeminiModel = (modelName: string): GenerativeModel => {
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

const getLiteLLMConfig = (): LiteLLMConfig | null => {
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

const getOpenRouterConfig = (globalConfig: Record<string, unknown> | null = null): OpenRouterConfig => {
  const settings = globalConfig || {};
  const openrouterSettings = (settings?.llmService as Record<string, unknown>)?.openrouter as Record<string, unknown> || {};
  const baseUrl = String(
    openrouterSettings.baseUrl
    || process.env.OPENROUTER_BASE_URL
    || DEFAULT_OPENROUTER_BASE_URL,
  ).trim().replace(/\/$/, '');
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const model = String(
    openrouterSettings.model
    || (settings?.llmService as Record<string, unknown>)?.model
    || (settings?.llmService as Record<string, unknown>)?.defaultModel
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

const parseLiteLLMResponse = (data: unknown): string => {
  const d = data as Record<string, unknown>;
  // Check for OpenRouter/LiteLLM error payloads first
  if (d?.error) {
    const errObj = d.error as Record<string, unknown>;
    const errMsg = String(errObj.message || errObj.type || 'Unknown provider error');
    const errCode = errObj.code || errObj.status || '';
    const err = new Error(`LLM provider error: ${errMsg}`) as LLMProviderError;
    err.providerCode = errCode as string | number;
    err.providerType = String(errObj.type || '');
    throw err;
  }
  const choices = d?.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const content = message?.content || choice?.text;
  if (!content) {
    throw new Error('LLM response missing content');
  }
  return String(content).trim();
};

const generateViaLiteLLM = async (prompt: string, options: GenerateOptions = {}): Promise<string> => {
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

const generateViaGemini = async (prompt: string, options: GenerateOptions = {}): Promise<string> => {
  const modelName = options.model || DEFAULT_MODEL;
  const model = getGeminiModel(modelName);
  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
};

const parseOpenRouterModel = (modelName: unknown): string => {
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

const stripProviderPrefix = (modelName: unknown): string => {
  const stripped = parseOpenRouterModel(modelName);
  // Also strip provider org prefixes like "anthropic/claude-3" -> not valid for Gemini
  // If it contains a slash and doesn't start with "gemini", it's not a Gemini model
  if (stripped.includes('/') && !stripped.startsWith('gemini')) {
    return DEFAULT_MODEL;
  }
  return stripped || DEFAULT_MODEL;
};

const generateViaOpenRouter = async (
  prompt: string,
  options: GenerateOptions = {},
  globalConfig: Record<string, unknown> | null = null,
): Promise<string> => {
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

export const generateText = async (prompt: string, options: GenerateOptions = {}): Promise<string> => {
  const globalModelConfig = await GlobalModelConfigService.getConfig({
    includeSecrets: true,
  }).catch((configErr: Error) => {
    console.warn('[llm-service] Failed to load model config, using defaults:', configErr.message);
    return null;
  });
  const configuredProvider = String((globalModelConfig as Record<string, unknown>)?.llmService
    ? ((globalModelConfig as Record<string, unknown>).llmService as Record<string, unknown>)?.provider
    : 'auto' || 'auto').toLowerCase();
  const llmServiceConfig = (globalModelConfig as Record<string, unknown>)?.llmService as Record<string, unknown> | undefined;
  const configuredModel = String(
    llmServiceConfig?.model
    || llmServiceConfig?.defaultModel
    || '',
  ).trim();
  const selectedModel = options.model || configuredModel || DEFAULT_MODEL;
  const runOptions: GenerateOptions = {
    ...options,
    model: selectedModel,
  };

  const shouldUseOpenRouter = configuredProvider === 'openrouter'
    || String(selectedModel).startsWith('openrouter/')
    || String(selectedModel).startsWith('openrouter:');
  if (shouldUseOpenRouter) {
    try {
      return await generateViaOpenRouter(prompt, runOptions, globalModelConfig as Record<string, unknown>);
    } catch (error) {
      const err = error as LLMProviderError;
      console.warn(
        `[llm-service] OpenRouter failed (model=${selectedModel}): ${err.message}${err.providerCode ? ` [code=${err.providerCode}]` : ''}`,
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
      const err = error as Error;
      console.warn(
        `[llm-service] LiteLLM failed (model=${selectedModel}): ${err.message}`,
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
      const err = error as Error;
      console.warn(
        `[llm-service] LiteLLM (auto) failed (model=${selectedModel}): ${err.message}`,
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

export default { generateText };
