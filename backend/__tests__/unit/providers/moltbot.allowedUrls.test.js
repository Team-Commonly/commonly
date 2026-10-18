/**
 * The moltbot provider's gateway URL and Commonly API URL may only name a URL
 * the operator configured, and a pod id used as a path segment must be an
 * ObjectId. These pin the checks in the provider itself, so they hold for
 * every route that constructs or calls it.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const { MoltbotProvider, MoltbotConnection } = require('../../../providers/moltbot');

const POD = '0123456789abcdef01234567';
const DEFAULT_GATEWAY = process.env.MOLTBOT_GATEWAY_URL || process.env.CLAWDBOT_GATEWAY_URL || 'ws://127.0.0.1:18789';

describe('moltbot provider: configured URLs only', () => {
  const saved = { gw: process.env.MOLTBOT_GATEWAY_ALLOWED_URLS, api: process.env.COMMONLY_API_URL };
  afterEach(() => {
    if (saved.gw === undefined) delete process.env.MOLTBOT_GATEWAY_ALLOWED_URLS;
    else process.env.MOLTBOT_GATEWAY_ALLOWED_URLS = saved.gw;
    if (saved.api === undefined) delete process.env.COMMONLY_API_URL;
    else process.env.COMMONLY_API_URL = saved.api;
    jest.clearAllMocks();
  });

  test('no gatewayUrl keeps the configured default', () => {
    expect(new MoltbotConnection({}).gatewayUrl).toBe(DEFAULT_GATEWAY);
  });

  test('a gatewayUrl outside the allowlist is refused, not followed', () => {
    delete process.env.MOLTBOT_GATEWAY_ALLOWED_URLS;
    expect(() => new MoltbotConnection({ gatewayUrl: 'wss://other.example/socket' }))
      .toThrow('gatewayUrl is not an allowed URL for this instance');
    expect(() => new MoltbotProvider({ gatewayUrl: 'wss://other.example/socket' }))
      .toThrow('gatewayUrl is not an allowed URL for this instance');
  });

  test('MOLTBOT_GATEWAY_ALLOWED_URLS widens the list, and the entry is what is used', () => {
    process.env.MOLTBOT_GATEWAY_ALLOWED_URLS = 'wss://gateway.example.test/socket';
    expect(new MoltbotConnection({ gatewayUrl: 'wss://GATEWAY.example.test/socket/' }).gatewayUrl)
      .toBe('wss://gateway.example.test/socket');
  });

  test('commonlyApiUrl defaults to localhost and may only name COMMONLY_API_URL', () => {
    process.env.COMMONLY_API_URL = 'http://backend.test.svc:5000';
    expect(new MoltbotProvider({}).commonlyApiUrl).toBe('http://localhost:5000');
    expect(new MoltbotProvider({ commonlyApiUrl: 'http://backend.test.svc:5000/' }).commonlyApiUrl)
      .toBe('http://backend.test.svc:5000');
    expect(() => new MoltbotProvider({ commonlyApiUrl: 'http://other.example' }))
      .toThrow('commonlyApiUrl is not an allowed URL for this instance');
  });
});

describe('moltbot provider: pod ids in API paths', () => {
  afterEach(() => jest.clearAllMocks());

  test.each([
    ['search', (p, pod) => p.search(pod, 'q')],
    ['getContext', (p, pod) => p.getContext(pod, {})],
    ['write', (p, pod) => p.write(pod, { content: 'x' })],
  ])('%s refuses a pod id that is not an ObjectId, before any request', async (_name, call) => {
    const provider = new MoltbotProvider({ apiToken: 'tok' });
    for (const bad of ['../x', `${POD}/../x`, `${POD}?x=1`, 'pod-1', undefined]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(call(provider, bad)).rejects.toThrow('podId must be a 24-character hex id');
    }
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a valid pod id reaches the configured API URL', async () => {
    axios.get.mockResolvedValue({ data: { ok: true } });
    const provider = new MoltbotProvider({ apiToken: 'tok' });
    await provider.search(POD, 'hello');
    expect(axios.get).toHaveBeenCalledWith(
      `http://localhost:5000/api/v1/search/${POD}?q=hello`,
      { headers: { Authorization: 'Bearer tok' } },
    );
  });
});
