/**
 * F105: llmService defaulted to `gemini-2.5-flash`, which LiteLLM served with
 * DeepSeek wherever Gemini was off (litellm.legacyAliases). With no model named,
 * a LiteLLM call now asks for the chart's LITELLM_CHAT_MODEL, else the agent
 * default; and only a Gemini name ever reaches Google's own API, including on
 * the fallback after a LiteLLM failure.
 */
const mockPost = jest.fn();
const mockGetConfig = jest.fn();
const mockGemini = jest.fn();
const mockGeminiModels = [];

jest.mock('axios', () => ({ post: (...args) => mockPost(...args) }));
jest.mock('../../../services/globalModelConfigService', () => ({
  __esModule: true,
  default: { getConfig: (...args) => mockGetConfig(...args) },
}));
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: ({ model }) => {
      mockGeminiModels.push(model);
      return { generateContent: (...args) => mockGemini(...args) };
    },
  })),
}));

// llmService caches the Gemini model it last built, so each test loads it fresh.
let generateText;

const ok = (content) => ({ data: { choices: [{ message: { content } }] } });
const geminiOk = (text) => ({ response: Promise.resolve({ text: () => text }) });
const KEYS = ['LLM_SERVICE_MODEL', 'LITELLM_BASE_URL', 'LITELLM_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
  'LITELLM_CHAT_MODEL', 'AGENT_DEFAULT_MODEL', 'LITELLM_DISABLED'];
const saved = {};

beforeEach(() => {
  jest.clearAllMocks();
  jest.isolateModules(() => {
    // eslint-disable-next-line global-require
    ({ generateText } = require('../../../services/llmService'));
  });
  mockGeminiModels.length = 0;
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.LITELLM_BASE_URL = 'http://litellm:4000';
  process.env.LITELLM_API_KEY = 'sk-test';
  // The global config named no model (a getConfig that failed reads the same).
  mockGetConfig.mockResolvedValue({ llmService: { provider: 'auto' } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  jest.restoreAllMocks();
});

describe('with no model named anywhere', () => {
  test('a LiteLLM call asks for the chat model the chart set', async () => {
    process.env.LITELLM_CHAT_MODEL = 'deepseek-flash-1017';
    mockPost.mockResolvedValueOnce(ok('A summary.'));
    await expect(generateText('summarize')).resolves.toBe('A summary.');
    expect(mockPost.mock.calls[0][1].model).toBe('deepseek-flash-1017');
  });

  test('with no chat model set, it asks for the agent default, never a Gemini name', async () => {
    process.env.AGENT_DEFAULT_MODEL = 'claude-haiku-5-5';
    mockPost.mockResolvedValueOnce(ok('A summary.'));
    await generateText('summarize');
    expect(mockPost.mock.calls[0][1].model).toBe('claude-haiku-5-5');
  });
});

describe('Google\'s own API gets only a Gemini name', () => {
  beforeEach(() => { process.env.GEMINI_API_KEY = 'g-test'; });

  test('after a LiteLLM failure, the Gemini fallback asks Google for a Gemini model, not the LiteLLM name', async () => {
    process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
    mockPost.mockRejectedValueOnce(new Error('LiteLLM down'));
    mockGemini.mockResolvedValueOnce(geminiOk('From Gemini.'));
    await expect(generateText('summarize')).resolves.toBe('From Gemini.');
    expect(mockGeminiModels).toEqual(['gemini-2.5-flash']);
  });

  test('a Gemini-direct provider with no model named calls Google with its default', async () => {
    mockGetConfig.mockResolvedValue({ llmService: { provider: 'gemini' } });
    mockGemini.mockResolvedValueOnce(geminiOk('From Gemini.'));
    await generateText('summarize');
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGeminiModels).toEqual(['gemini-2.5-flash']);
  });

  test('with no LiteLLM at all, the call reaches Google with a Gemini name', async () => {
    delete process.env.LITELLM_BASE_URL;
    process.env.LITELLM_CHAT_MODEL = 'deepseek-v4-flash';
    mockGemini.mockResolvedValueOnce(geminiOk('From Gemini.'));
    await generateText('summarize');
    expect(mockGeminiModels).toEqual(['gemini-2.5-flash']);
  });

  test('a Gemini name the caller chose reaches Google unchanged', async () => {
    mockGetConfig.mockResolvedValue({ llmService: { provider: 'gemini' } });
    mockGemini.mockResolvedValueOnce(geminiOk('From Gemini.'));
    await generateText('summarize', { model: 'gemini-2.5-pro' });
    expect(mockGeminiModels).toEqual(['gemini-2.5-pro']);
  });
});
