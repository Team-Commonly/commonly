/**
 * `getOpenRouterConfig` resolves its base URL from values the operator set
 * (the default, OPENROUTER_BASE_URL, OPENROUTER_ALLOWED_BASE_URLS). The global
 * model config's `llmService.openrouter.baseUrl` may name one of them; any
 * other value is ignored.
 */
const { getOpenRouterConfig } = require('../../../services/llmService');

const DEFAULT = 'https://openrouter.ai/api/v1';
const withBase = (baseUrl) => ({ llmService: { openrouter: { baseUrl } } });

describe('getOpenRouterConfig base URL', () => {
  const saved = {};
  const KEYS = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'OPENROUTER_ALLOWED_BASE_URLS'];
  beforeEach(() => {
    KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    process.env.OPENROUTER_API_KEY = 'test-key';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    jest.restoreAllMocks();
  });

  test('unset everywhere: the default', () => {
    expect(getOpenRouterConfig(null).baseUrl).toBe(DEFAULT);
  });

  test('the configured default is accepted as written', () => {
    expect(getOpenRouterConfig(withBase('https://openrouter.ai/api/v1/')).baseUrl).toBe(DEFAULT);
  });

  test('a configured URL outside the allowlist is ignored, falling back to OPENROUTER_BASE_URL', () => {
    process.env.OPENROUTER_BASE_URL = 'http://litellm:4000/v1';
    expect(getOpenRouterConfig(withBase('https://other.example/v1')).baseUrl).toBe('http://litellm:4000/v1');
  });

  test('a configured URL outside the allowlist is ignored, falling back to the default', () => {
    expect(getOpenRouterConfig(withBase('https://user:pw@openrouter.ai/api/v1')).baseUrl).toBe(DEFAULT);
    expect(getOpenRouterConfig(withBase('https://openrouter.ai.other.example/api/v1')).baseUrl).toBe(DEFAULT);
  });

  test('OPENROUTER_ALLOWED_BASE_URLS lets the config choose an operator-listed URL', () => {
    process.env.OPENROUTER_ALLOWED_BASE_URLS = 'https://proxy.example.test/openrouter/v1';
    expect(getOpenRouterConfig(withBase('https://proxy.example.test/openrouter/v1/')).baseUrl)
      .toBe('https://proxy.example.test/openrouter/v1');
  });
});
