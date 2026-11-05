/**
 * F92: the platform's own model calls (summaries, digests, pod skills, avatar
 * descriptions) read pod content. With LLM_SERVICE_MODEL set, every call goes to
 * that model through LiteLLM, whatever the caller or the global model config
 * names, and a failure stays a failure: no Gemini or OpenRouter request follows.
 */
const mockPost = jest.fn();
const mockGetConfig = jest.fn();
const mockGemini = jest.fn();

jest.mock('axios', () => ({ post: (...args) => mockPost(...args) }));
jest.mock('../../../services/globalModelConfigService', () => ({
  __esModule: true,
  default: { getConfig: (...args) => mockGetConfig(...args) },
}));
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: (...args) => mockGemini(...args) }),
  })),
}));

const { generateText } = require('../../../services/llmService');

const ok = (content) => ({ data: { choices: [{ message: { content } }] } });
const KEYS = ['LLM_SERVICE_MODEL', 'LITELLM_BASE_URL', 'LITELLM_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'LITELLM_CHAT_MODEL'];
const saved = {};

beforeEach(() => {
  jest.clearAllMocks();
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.LITELLM_BASE_URL = 'http://litellm:4000';
  process.env.LITELLM_API_KEY = 'sk-test';
  process.env.GEMINI_API_KEY = 'g-test';
  process.env.OPENROUTER_API_KEY = 'or-test';
  // A config that would otherwise send the call to OpenRouter.
  mockGetConfig.mockResolvedValue({ llmService: { provider: 'openrouter', model: 'openrouter/some-model' } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  jest.restoreAllMocks();
});

describe('with LLM_SERVICE_MODEL set', () => {
  beforeEach(() => { process.env.LLM_SERVICE_MODEL = 'claude-haiku-5-5'; });

  test('every call goes to that model through LiteLLM, whatever the caller and the config name', async () => {
    mockPost.mockResolvedValueOnce(ok('A summary.'));

    await expect(generateText('summarize', { temperature: 0.4, model: 'deepseek-v4-flash' })).resolves.toBe('A summary.');

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('http://litellm:4000/chat/completions');
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.disable_fallbacks).toBe(true);
    // One-shot text: thinking off, so the output budget is the answer's; and no
    // sampling value, which Haiku 5.5 rejects.
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('temperature');
  });

  test('a failure is not retried on another provider', async () => {
    mockPost.mockRejectedValueOnce(new Error('LiteLLM 500'));

    await expect(generateText('summarize', { temperature: 0.4 })).rejects.toThrow('LiteLLM 500');

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockGemini).not.toHaveBeenCalled();
  });
});

describe('without it', () => {
  test('the configured provider still decides, as before', async () => {
    mockGetConfig.mockResolvedValue({ llmService: { provider: 'litellm', model: 'deepseek-v4-flash' } });
    mockPost.mockResolvedValueOnce(ok('Old path.'));

    await expect(generateText('summarize', { temperature: 0.4 })).resolves.toBe('Old path.');

    const [, body] = mockPost.mock.calls[0];
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.temperature).toBe(0.4);
    expect(body).not.toHaveProperty('disable_fallbacks');
  });
});
