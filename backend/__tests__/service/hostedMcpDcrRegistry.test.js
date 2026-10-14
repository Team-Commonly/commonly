process.env.PG_HOST = '';

const Model = require('../../models/HostedMcpDcrRegistration');
const {
  ensureDcrClient,
  dcrClientForRow,
  refuseDcrClient,
} = require('../../services/hostedMcpDcrRegistry');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

const entry = {
  id: 'close', title: 'Close', client: 'dcr', issuer: 'https://auth.close.com',
  resource: 'https://mcp.close.com/mcp', scopes: ['mcp.read'], tools: [],
};
const callback = 'https://api.commonly.me/api/integrations/connect/hosted-mcp/close/callback';
const metadata = {
  issuer: entry.issuer,
  authorization_endpoint: `${entry.issuer}/authorize`,
  token_endpoint: `${entry.issuer}/token`,
  registration_endpoint: `${entry.issuer}/register`,
  token_endpoint_auth_methods_supported: ['none'],
};

const registrationFetch = (seen, clientId = 'registered-1') => jest.fn(async (url, init) => {
  seen.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({
    client_id: clientId,
    token_endpoint_auth_method: 'none',
    redirect_uris: [callback],
  }), { status: 201 });
});

describe('instance-scoped hosted MCP DCR registry', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });
  beforeEach(async () => { await Model.deleteMany({}); });
  afterAll(async () => { await clearMongoDb(); await closeMongoDb(); });

  test('first start registers a public client once and a second reuses it', async () => {
    const initialize = jest.spyOn(Model, 'init');
    const sent = [];
    const fetch = registrationFetch(sent);
    const first = await ensureDcrClient(entry, metadata, callback, fetch);
    const second = await ensureDcrClient(entry, metadata, callback, fetch);

    expect(first).toEqual({ clientId: 'registered-1' });
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalled();
    initialize.mockRestore();
    expect(sent[0].body).toMatchObject({
      token_endpoint_auth_method: 'none',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(await Model.countDocuments({})).toBe(1);
    expect((await Model.findOne({})).toObject()).not.toHaveProperty('clientSecret');
  });

  test('concurrent starts authorize with one stored client', async () => {
    await Model.init();
    const sent = [];
    let release;
    const bothPosted = new Promise((resolve) => { release = resolve; });
    let posts = 0;
    const fetch = jest.fn(async (_url, init) => {
      posts += 1;
      const registrationNumber = posts;
      sent.push(JSON.parse(init.body));
      if (posts === 2) release();
      await bothPosted;
      return new Response(JSON.stringify({
        client_id: `registered-${registrationNumber}`,
        token_endpoint_auth_method: 'none',
        redirect_uris: [callback],
      }), { status: 201 });
    });
    const [a, b] = await Promise.all([
      ensureDcrClient(entry, metadata, callback, fetch),
      ensureDcrClient(entry, metadata, callback, fetch),
    ]);
    expect(posts).toBe(2);
    expect(a.clientId).toBe(b.clientId);
    expect(await Model.countDocuments({ current: true })).toBe(1);
    expect(Model.schema.indexes()).toContainEqual([
      { entryId: 1, issuer: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { current: true } }),
    ]);
  });

  test('invalid_client retires only its registration; old rows then reconnect', async () => {
    const sent = [];
    await ensureDcrClient(entry, metadata, callback, registrationFetch(sent, 'old'));
    await refuseDcrClient(entry, 'old');
    expect(await dcrClientForRow(entry, 'old')).toBeNull();
    const next = await ensureDcrClient(entry, metadata, callback, registrationFetch(sent, 'new'));
    expect(next).toEqual({ clientId: 'new' });
    expect(await dcrClientForRow(entry, 'new')).toEqual(next);
    expect(await Model.countDocuments({})).toBe(2);
  });

  test('host move retires the old client for starts while its rows keep using it', async () => {
    const sent = [];
    await ensureDcrClient(entry, metadata, callback, registrationFetch(sent, 'old'));
    const moved = callback.replace('api.commonly.me', 'api.example.com');
    const fetch = jest.fn(async () => new Response(JSON.stringify({
      client_id: 'new', token_endpoint_auth_method: 'none', redirect_uris: [moved],
    }), { status: 201 }));
    const next = await ensureDcrClient(entry, metadata, moved, fetch);
    expect(next).toEqual({ clientId: 'new' });
    expect(await dcrClientForRow(entry, 'old')).toEqual({ clientId: 'old' });
    expect(await Model.findOne({ clientId: 'old' })).toMatchObject({ current: false });
  });

  test('refuses AS metadata without none before registration and refuses a secret-bearing answer', async () => {
    const fetch = registrationFetch([]);
    await expect(ensureDcrClient(entry, {
      ...metadata, token_endpoint_auth_methods_supported: ['client_secret_basic'],
    }, callback, fetch)).rejects.toMatchObject({ code: 'client_registration_unsupported' });
    expect(fetch).not.toHaveBeenCalled();
    const secretAnswer = jest.fn(async () => new Response(JSON.stringify({
      client_id: 'private', client_secret: 'must-not-store',
      token_endpoint_auth_method: 'client_secret_basic', redirect_uris: [callback],
    }), { status: 201 }));
    await expect(ensureDcrClient(entry, metadata, callback, secretAnswer))
      .rejects.toMatchObject({ code: 'client_registration_unsupported' });
    expect(await Model.countDocuments({})).toBe(0);
  });

  test('a CIMD entry never touches the registry or the AS', async () => {
    const fetch = registrationFetch([]);
    await expect(ensureDcrClient({ ...entry, client: 'cimd' }, metadata, callback, fetch))
      .rejects.toMatchObject({ code: 'client_registration_unsupported' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await Model.countDocuments({})).toBe(0);
  });
});
