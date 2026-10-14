// The X and Instagram API base is instance configuration, never row data:
// `apiBase` is in SERVER_OWNED_CONFIG_KEYS, and the providers read only the
// environment (or the official default). These arms give each provider a row
// that carries an `apiBase` and assert the request still goes to the official
// host, which is where the row's access token is sent.
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const createXProvider = require('../../../integrations/providers/xProvider');
const createInstagramProvider = require('../../../integrations/providers/instagramProvider');

const ROW_API_BASE = 'https://row-supplied.example.test';

describe('social providers take the API base from the instance, not the row', () => {
  const savedEnv = {};

  beforeEach(() => {
    ['X_API_BASE_URL', 'INSTAGRAM_GRAPH_API_BASE'].forEach((key) => {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    Object.entries(savedEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  test('X: a row apiBase is ignored and the request goes to the official API', async () => {
    axios.get.mockResolvedValue({ data: {} });
    const provider = createXProvider({
      _id: 'integration-x',
      config: { accessToken: 'row-token', username: 'acme', apiBase: ROW_API_BASE },
    });

    await provider.syncRecent({}).catch(() => {});

    expect(axios.get).toHaveBeenCalled();
    const [url, options] = axios.get.mock.calls[0];
    expect(url).toBe('https://api.x.com/2/users/by/username/acme');
    expect(options.headers.Authorization).toBe('Bearer row-token');
    axios.get.mock.calls.forEach(([requested]) => expect(requested).not.toContain('row-supplied'));
  });

  test('X: the instance environment still sets the base', async () => {
    process.env.X_API_BASE_URL = 'https://x-proxy.instance.test/2';
    axios.get.mockResolvedValue({ data: {} });
    const provider = createXProvider({
      _id: 'integration-x',
      config: { accessToken: 'row-token', username: 'acme', apiBase: ROW_API_BASE },
    });

    await provider.syncRecent({}).catch(() => {});

    expect(axios.get.mock.calls[0][0]).toBe('https://x-proxy.instance.test/2/users/by/username/acme');
  });

  test('Instagram: a row apiBase is ignored and the request goes to the official API', async () => {
    axios.get.mockResolvedValue({ data: { data: [] } });
    const provider = createInstagramProvider({
      _id: 'integration-ig',
      config: { accessToken: 'row-token', igUserId: '1789', apiBase: ROW_API_BASE },
    });

    await provider.syncRecent({}).catch(() => {});

    expect(axios.get).toHaveBeenCalled();
    expect(axios.get.mock.calls[0][0]).toBe('https://graph.facebook.com/v19.0/1789/media');
    axios.get.mock.calls.forEach(([requested]) => expect(requested).not.toContain('row-supplied'));
  });
});
