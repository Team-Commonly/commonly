const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_MODEL = 'gemini-2.0-flash';

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

const parseLiteLLMResponse = (data) => {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content || choice?.text;
  if (!content) {
    throw new Error('LiteLLM response missing content');
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
      max_tokens: options.maxTokens,
    },
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
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

const generateText = async (prompt, options = {}) => {
  if (process.env.LITELLM_BASE_URL) {
    return generateViaLiteLLM(prompt, options);
  }
  return generateViaGemini(prompt, options);
};

module.exports = {
  generateText,
};
