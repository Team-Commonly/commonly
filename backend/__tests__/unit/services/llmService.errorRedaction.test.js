/**
 * F627: what the LLM call throws must carry no request. An AxiosError holds the
 * Authorization header in `config` and the raw header line in `request._header`,
 * and callers log and rethrow it. The thrown error keeps message, name, code,
 * status and the provider's response, which podSkillService reads to spot a
 * rejected key.
 */
const util = require('util');

const mockPost = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('axios', () => ({ post: (...args) => mockPost(...args) }));
jest.mock('../../../services/globalModelConfigService', () => ({
  __esModule: true,
  default: { getConfig: (...args) => mockGetConfig(...args) },
}));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn() }));

const { generateText } = require('../../../services/llmService');

const FAKE_KEY = 'fake-llm-key-123';

const axiosFailure = (status) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.name = 'AxiosError';
  err.code = 'ERR_BAD_REQUEST';
  err.isAxiosError = true;
  err.config = { headers: { Authorization: `Bearer ${FAKE_KEY}` }, data: '{"prompt":"p"}' };
  err.request = { _header: `POST /chat/completions\r\nAuthorization: Bearer ${FAKE_KEY}\r\n` };
  err.response = { status, data: { error: { message: 'invalid key' } }, headers: {} };
  return err;
};

const KEYS = ['LLM_SERVICE_MODEL', 'LITELLM_BASE_URL', 'LITELLM_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'];
const saved = {};

beforeEach(() => {
  jest.clearAllMocks();
  KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  process.env.LITELLM_BASE_URL = 'http://litellm:4000';
  process.env.LITELLM_API_KEY = FAKE_KEY;
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  mockGetConfig.mockResolvedValue({ llmService: { provider: 'litellm', model: 'm' } });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  jest.restoreAllMocks();
});

describe('llmService thrown errors', () => {
  it('a LiteLLM failure carries status and code and no request', async () => {
    process.env.LLM_SERVICE_MODEL = 'pinned';
    mockPost.mockRejectedValue(axiosFailure(401));
    const err = await generateText('hi').catch((e) => e);
    expect(err.message).toBe('Request failed with status code 401');
    expect(err.name).toBe('AxiosError');
    expect(err.code).toBe('ERR_BAD_REQUEST');
    expect(err.status).toBe(401);
    expect(err.response).toEqual({ status: 401, data: { error: { message: 'invalid key' } } });
    expect(err.config).toBeUndefined();
    expect(err.request).toBeUndefined();
    expect(util.inspect(err, { depth: 5 })).not.toContain(FAKE_KEY);
  });

  it('an OpenRouter failure is sanitised the same way', async () => {
    mockGetConfig.mockResolvedValue({ llmService: { provider: 'openrouter', model: 'openrouter/x' } });
    mockPost.mockRejectedValue(axiosFailure(403));
    const err = await generateText('hi').catch((e) => e);
    expect(err.status).toBe(403);
    expect(util.inspect(err, { depth: 5 })).not.toContain(FAKE_KEY);
  });

  it('a network error with no response still throws a plain error', async () => {
    process.env.LLM_SERVICE_MODEL = 'pinned';
    const net = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', config: { headers: { Authorization: `Bearer ${FAKE_KEY}` } } });
    mockPost.mockRejectedValue(net);
    const err = await generateText('hi').catch((e) => e);
    expect(err.code).toBe('ECONNREFUSED');
    expect(err.response).toBeUndefined();
    expect(util.inspect(err, { depth: 5 })).not.toContain(FAKE_KEY);
  });

  it('podSkillService still reads a 401 from the real llmService as a rejected key', async () => {
    process.env.LLM_SERVICE_MODEL = 'pinned';
    mockPost.mockRejectedValue(axiosFailure(401));
    const err = await generateText('hi').catch((e) => e);
    const status = err?.status ?? err?.response?.status;
    expect(status === 401 || status === 403).toBe(true);
  });
});
