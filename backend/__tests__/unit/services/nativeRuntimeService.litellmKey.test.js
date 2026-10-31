/**
 * TASK-555: hosted turns call LiteLLM on the backend's budgeted service key
 * (LITELLM_API_KEY) and fall back to the master key only where no service key
 * is deployed. The standalone guardrail check is the exception: LiteLLM serves
 * /guardrails/apply_guardrail to proxy admins only, so it keeps the master key.
 */
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

const { resolveLiteLLM, guardrailCheckKey } = require('../../../services/nativeRuntimeService');

const ENV_KEYS = ['LITELLM_BASE_URL', 'LITELLM_API_KEY', 'LITELLM_MASTER_KEY'];
const savedEnv = {};

beforeEach(() => {
  ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  process.env.LITELLM_BASE_URL = 'http://litellm:4000/';
});

afterEach(() => {
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

describe('resolveLiteLLM', () => {
  test('prefers the service key over the master key', () => {
    process.env.LITELLM_API_KEY = 'sk-svc-backend';
    process.env.LITELLM_MASTER_KEY = 'sk-master';
    expect(resolveLiteLLM()).toEqual({ baseUrl: 'http://litellm:4000', apiKey: 'sk-svc-backend' });
  });

  test('falls back to the master key when no service key is set, or it is blank', () => {
    process.env.LITELLM_MASTER_KEY = 'sk-master';
    expect(resolveLiteLLM().apiKey).toBe('sk-master');
    process.env.LITELLM_API_KEY = '   ';
    expect(resolveLiteLLM().apiKey).toBe('sk-master');
  });

  test('is unavailable with no key or no base URL', () => {
    expect(resolveLiteLLM()).toBeNull();
    process.env.LITELLM_API_KEY = 'sk-svc-backend';
    delete process.env.LITELLM_BASE_URL;
    expect(resolveLiteLLM()).toBeNull();
  });
});

describe('guardrailCheckKey', () => {
  test('uses the master key even when the turn runs on the service key', () => {
    process.env.LITELLM_MASTER_KEY = 'sk-master';
    expect(guardrailCheckKey({ apiKey: 'sk-svc-backend' })).toBe('sk-master');
  });

  test('falls back to the turn key when no master key is deployed', () => {
    expect(guardrailCheckKey({ apiKey: 'sk-svc-backend' })).toBe('sk-svc-backend');
  });
});
