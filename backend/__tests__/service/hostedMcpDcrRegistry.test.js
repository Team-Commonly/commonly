process.env.PG_HOST = '';
process.env.CONNECTOR_SECRET_KEYS = `dcr-test:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'dcr-test';

const Model = require('../../models/HostedMcpDcrRegistration');
const {
  ensureDcrClient,
  dcrClientForRow,
  refuseDcrClient,
  retireDcrClientIfUnknown,
  retireCurrentDcrClient,
  DCR_ASK_INTERVAL_MS,
} = require('../../services/hostedMcpDcrRegistry');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const ConnectorSecret = require('../../models/ConnectorSecret');
const connectorSecrets = require('../../services/connectorSecrets');
const {
  buildTokenExchangeRequest, buildRefreshRequest, buildRevocationRequest,
} = require('../../services/hostedMcpIntakeService');
const { AIRTABLE_ENTRY } = require('../../integrations/hostedMcp/airtable');
const AIRTABLE_AS_CAPTURE = require('../fixtures/hostedMcp/airtable-authorization-server-2026-10-28.json');

const entry = {
  id: 'close',
  title: 'Close',
  client: 'dcr',
  issuer: 'https://auth.close.com',
  resource: 'https://mcp.close.com/mcp',
  scopes: ['mcp.read'],
  tools: [],
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
  beforeEach(async () => { await Model.deleteMany({}); await ConnectorSecret.deleteMany({}); });
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

  // TASK-248 inverted the first half of this arm: a vendor listing only
  // client_secret_* methods now gets a confidential client (below). What stays
  // refused before any POST is a vendor naming no method this registry
  // supports, or naming none at all.
  test('refuses before any POST when the vendor names no supported registration method', async () => {
    const fetch = registrationFetch([]);
    for (const supported of [['private_key_jwt'], [], undefined]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(ensureDcrClient(entry, {
        ...metadata, token_endpoint_auth_methods_supported: supported,
      }, callback, fetch)).rejects.toMatchObject({ code: 'client_registration_unsupported' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await Model.countDocuments({})).toBe(0);
  });

  test('a public registration answered with a secret is still refused, and nothing is stored', async () => {
    const secretAnswer = jest.fn(async () => new Response(JSON.stringify({
      client_id: 'private',
      client_secret: 'must-not-store',
      token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: [callback],
    }), { status: 201 }));
    await expect(ensureDcrClient(entry, metadata, callback, secretAnswer))
      .rejects.toMatchObject({ code: 'client_registration_unsupported' });
    expect(await Model.countDocuments({})).toBe(0);
    expect(await ConnectorSecret.countDocuments({})).toBe(0);
  });

  // The shared metadata puts the endpoint at issuer + /register, so only an
  // endpoint on another path shows the POST follows the metadata.
  test('registers at the endpoint the metadata names, never one guessed from the issuer', async () => {
    const sent = [];
    const elsewhere = { ...metadata, registration_endpoint: 'https://register.close.com/oauth2/v1/clients' };
    await ensureDcrClient(entry, elsewhere, callback, registrationFetch(sent));
    expect(sent.map(({ url }) => url)).toEqual(['https://register.close.com/oauth2/v1/clients']);
  });

  test('an answer that does not confirm our sole callback is refused, and nothing is stored', async () => {
    const unconfirmed = [
      ['https://elsewhere.example/callback'],
      [callback, 'https://elsewhere.example/callback'],
      [],
      undefined,
    ];
    for (const redirectUris of unconfirmed) {
      const answer = jest.fn(async () => new Response(JSON.stringify({
        client_id: 'unconfirmed',
        token_endpoint_auth_method: 'none',
        redirect_uris: redirectUris,
      }), { status: 201 }));
      // eslint-disable-next-line no-await-in-loop
      await expect(ensureDcrClient(entry, metadata, callback, answer))
        .rejects.toMatchObject({ code: 'client_registration_unsupported' });
      expect(answer).toHaveBeenCalledTimes(1);
    }
    expect(await Model.countDocuments({})).toBe(0);
  });

  describe('a vendor that offers only confidential registration (TASK-248)', () => {
    const confidential = { ...metadata, token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] };
    const confidentialAnswer = (seen, overrides = {}) => jest.fn(async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        client_id: 'conf-1',
        client_secret: 'issued-secret-1',
        token_endpoint_auth_method: 'client_secret_basic',
        redirect_uris: [callback],
        client_secret_expires_at: 0,
        registration_access_token: 'never-stored',
        ...overrides,
      }), { status: 201 });
    });

    test('registers with the vendor\'s listed method, keeps the secret encrypted and owned by the row, and reuses it', async () => {
      const sent = [];
      const fetch = confidentialAnswer(sent);
      const first = await ensureDcrClient(entry, confidential, callback, fetch);
      const second = await ensureDcrClient(entry, confidential, callback, fetch);
      expect(first).toEqual({ clientId: 'conf-1', clientSecret: 'issued-secret-1', tokenEndpointAuthMethod: 'client_secret_basic' });
      expect(second).toEqual(first);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sent[0]).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic', redirect_uris: [callback] });

      const row = (await Model.findOne({})).toObject();
      expect(row.tokenEndpointAuthMethod).toBe('client_secret_basic');
      expect(JSON.stringify(row)).not.toMatch(/issued-secret-1|never-stored/);
      const secret = await ConnectorSecret.findById(row.clientSecretRef).lean();
      expect(String(secret.integrationId)).toBe(String(row._id));
      expect(secret.kind).toBe('hosted-mcp-dcr-client-secret');
      expect(secret.ciphertext).not.toMatch(/issued-secret-1/);
      expect(await connectorSecrets.get(row.clientSecretRef)).toBe('issued-secret-1');
    });

    test('two concurrent first starts keep only the winner\'s secret, and both use the winner\'s client', async () => {
      await Model.init();
      let release;
      const bothPosted = new Promise((resolve) => { release = resolve; });
      let posts = 0;
      const fetch = jest.fn(async () => {
        posts += 1;
        const n = posts;
        if (posts === 2) release();
        await bothPosted;
        return new Response(JSON.stringify({
          client_id: `conf-race-${n}`,
          client_secret: `race-secret-${n}`,
          token_endpoint_auth_method: 'client_secret_basic',
          redirect_uris: [callback],
        }), { status: 201 });
      });
      const [a, b] = await Promise.all([
        ensureDcrClient(entry, confidential, callback, fetch),
        ensureDcrClient(entry, confidential, callback, fetch),
      ]);
      expect(posts).toBe(2);
      expect(a).toEqual(b);
      const winner = await Model.findOne({ current: true }).lean();
      expect(a.clientId).toBe(winner.clientId);
      // The loser's secret is deleted; only the stored registration's remains.
      const secrets = await ConnectorSecret.find({}).lean();
      expect(secrets.map((secret) => String(secret._id))).toEqual([winner.clientSecretRef]);
    });

    test('client_secret_post when that is the only secret method the vendor lists', async () => {
      const sent = [];
      const client = await ensureDcrClient(
        entry, 
        { ...metadata, token_endpoint_auth_methods_supported: ['client_secret_post'] },
        callback, 
        confidentialAnswer(sent, { token_endpoint_auth_method: 'client_secret_post' }),
      );
      expect(sent[0].token_endpoint_auth_method).toBe('client_secret_post');
      expect(client.tokenEndpointAuthMethod).toBe('client_secret_post');
    });

    test('an answer without a secret, or with another auth method, is refused and stores nothing', async () => {
      const postOnly = { ...metadata, token_endpoint_auth_methods_supported: ['client_secret_post'] };
      for (const [vendor, overrides] of [
        [confidential, { client_secret: undefined }],
        [confidential, { client_secret: '' }],
        [confidential, { token_endpoint_auth_method: 'client_secret_post' }],
        // RFC 7591: an omitted method means client_secret_basic, a mismatch for a post-only vendor.
        [postOnly, { token_endpoint_auth_method: undefined }],
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await expect(ensureDcrClient(entry, vendor, callback, confidentialAnswer([], overrides)))
          .rejects.toMatchObject({ code: 'client_registration_unsupported' });
      }
      expect(await Model.countDocuments({})).toBe(0);
      expect(await ConnectorSecret.countDocuments({})).toBe(0);
    });

    test('a secret that lapses is replaced by registering again before it does', async () => {
      const now = new Date('2026-10-21T12:00:00Z');
      // Each secret the vendor issues lapses two days after the first start.
      const day = 24 * 60 * 60 * 1000;
      let n = 0;
      const fetch = jest.fn(async () => {
        n += 1;
        return new Response(JSON.stringify({
          client_id: `conf-${n}`,
          client_secret: `secret-${n}`,
          token_endpoint_auth_method: 'client_secret_basic',
          redirect_uris: [callback],
          client_secret_expires_at: Math.floor((now.getTime() + n * 2 * day) / 1000),
        }), { status: 201 });
      });
      const first = await ensureDcrClient(entry, confidential, callback, fetch, now);
      expect(first.clientId).toBe('conf-1');
      const later = new Date(now.getTime() + 36 * 60 * 60 * 1000); // inside the 24 h margin
      const renewed = await ensureDcrClient(entry, confidential, callback, fetch, later);
      expect(renewed.clientId).toBe('conf-2');
      expect(await Model.countDocuments({ current: true })).toBe(1);
      // The retired client still serves rows it minted, with its own secret.
      expect(await dcrClientForRow(entry, 'conf-1')).toEqual({
        clientId: 'conf-1', clientSecret: 'secret-1', tokenEndpointAuthMethod: 'client_secret_basic',
      });
    });

    test('an already-lapsing secret in the answer is refused', async () => {
      const now = new Date('2026-10-21T12:00:00Z');
      await expect(ensureDcrClient(
        entry, 
        confidential, 
        callback,
        confidentialAnswer([], { client_secret_expires_at: Math.floor(now.getTime() / 1000) + 60 }), 
        now,
      ))
        .rejects.toMatchObject({ code: 'client_registration_refused' });
    });

    test('a refused client\'s secret is deleted with it', async () => {
      await ensureDcrClient(entry, confidential, callback, confidentialAnswer([]));
      const { clientSecretRef } = await Model.findOne({}).lean();
      await refuseDcrClient(entry, 'conf-1');
      expect(await ConnectorSecret.findById(clientSecretRef)).toBeNull();
      expect(await dcrClientForRow(entry, 'conf-1')).toBeNull();
    });

    test('a confidential registration with no secret ref is replaced, never used without its secret', async () => {
      await ensureDcrClient(entry, confidential, callback, confidentialAnswer([], { client_id: 'conf-noref' }));
      await Model.updateOne({ clientId: 'conf-noref' }, { $set: { clientSecretRef: null } });
      expect(await dcrClientForRow(entry, 'conf-noref')).toBeNull();
      const client = await ensureDcrClient(entry, confidential, callback, confidentialAnswer([], { client_id: 'conf-fresh' }));
      expect(client.clientId).toBe('conf-fresh');
    });

    test('a registration whose secret key left the ring is replaced on the next start', async () => {
      await ensureDcrClient(entry, confidential, callback, confidentialAnswer([], { client_id: 'conf-oldkey' }));
      const keys = process.env.CONNECTOR_SECRET_KEYS;
      const active = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
      process.env.CONNECTOR_SECRET_KEYS = `dcr-rotated:${Buffer.alloc(32, 9).toString('base64')}`;
      process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'dcr-rotated';
      try {
        expect(await dcrClientForRow(entry, 'conf-oldkey')).toBeNull();
        const client = await ensureDcrClient(entry, confidential, callback, confidentialAnswer([], { client_id: 'conf-newkey' }));
        expect(client).toMatchObject({ clientId: 'conf-newkey', clientSecret: 'issued-secret-1' });
      } finally {
        process.env.CONNECTOR_SECRET_KEYS = keys;
        process.env.CONNECTOR_SECRET_ACTIVE_KEY = active;
      }
    });

    test('a registration whose secret can no longer be read is replaced on the next start', async () => {
      await ensureDcrClient(entry, confidential, callback, confidentialAnswer([], { client_id: 'conf-old' }));
      await ConnectorSecret.deleteMany({});
      const client = await ensureDcrClient(entry, confidential, callback, confidentialAnswer([], { client_id: 'conf-new' }));
      expect(client.clientId).toBe('conf-new');
      expect(await dcrClientForRow(entry, 'conf-old')).toBeNull();
    });

    test('the token and revocation calls authenticate with the registered method, and PKCE still rides', async () => {
      const client = await ensureDcrClient(entry, confidential, callback, confidentialAnswer([]));
      const exchange = buildTokenExchangeRequest(entry, confidential, client, {
        code: 'code-1', codeVerifier: 'verifier-1', redirectUri: callback,
      });
      expect(exchange.headers.Authorization).toBe(`Basic ${Buffer.from('conf-1:issued-secret-1').toString('base64')}`);
      expect(exchange.body.get('code_verifier')).toBe('verifier-1');
      expect(exchange.body.get('client_secret')).toBeNull();

      // A recorded method is sent as recorded, never filtered by an
      // advertised list. The removal passes `{}` for a dcr entry, and RFC 8414
      // defaults an omitted list to basic, which turned a post-registered client
      // into Basic. Held on both inputs: no revocation metadata at all, and a
      // discovered document that omits the revocation list.
      const post = { ...client, tokenEndpointAuthMethod: 'client_secret_post' };
      for (const revocationMetadata of [{}, confidential]) {
        const revoke = buildRevocationRequest(entry, revocationMetadata, post, { token: 'tok', tokenTypeHint: 'refresh_token' });
        expect(revoke.headers.Authorization).toBeUndefined();
        expect(revoke.body.get('client_id')).toBe('conf-1');
        expect(revoke.body.get('client_secret')).toBe('issued-secret-1');
        const refresh = buildRefreshRequest(entry, revocationMetadata, post, { refreshToken: 'rt-1' });
        expect(refresh.body.get('client_secret')).toBe('issued-secret-1');
      }
    });

    test('refresh still sends the secret when the caller copies only clientId and clientSecret', async () => {
      // hostedMcpCredentialService and connectionRemovalService pass the client on as
      // { clientId, clientSecret }; without the secret the vendor answers invalid_client
      // and the registration is poisoned for every row it minted.
      const { clientId, clientSecret } = await ensureDcrClient(entry, confidential, callback, confidentialAnswer([]));
      const refresh = buildRefreshRequest(entry, confidential, { clientId, clientSecret }, { refreshToken: 'rt-1' });
      expect(refresh.headers.Authorization).toBe(`Basic ${Buffer.from('conf-1:issued-secret-1').toString('base64')}`);

      const postOnly = { ...metadata, token_endpoint_auth_methods_supported: ['client_secret_post'] };
      const viaPost = buildRefreshRequest(entry, postOnly, { clientId, clientSecret }, { refreshToken: 'rt-1' });
      expect(viaPost.body.get('client_secret')).toBe('issued-secret-1');
    });

    test('a public DCR client still sends only its client_id', async () => {
      const client = await ensureDcrClient(entry, metadata, callback, registrationFetch([]));
      const exchange = buildTokenExchangeRequest(entry, metadata, client, {
        code: 'code-1', codeVerifier: 'verifier-1', redirectUri: callback,
      });
      expect(exchange.headers.Authorization).toBeUndefined();
      expect(exchange.body.get('client_id')).toBe('registered-1');
      expect(exchange.body.get('client_secret')).toBeNull();
    });
  });

  test('Airtable registers once, as a public client, at its captured registration endpoint', async () => {
    const airtableCallback = 'https://api.commonly.me/api/integrations/connect/hosted-mcp/airtable/callback';
    const sent = [];
    const fetch = jest.fn(async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        client_id: 'airtable-registered',
        token_endpoint_auth_method: 'none',
        redirect_uris: [airtableCallback],
      }), { status: 201 });
    });
    const client = await ensureDcrClient(AIRTABLE_ENTRY, AIRTABLE_AS_CAPTURE.metadata, airtableCallback, fetch);

    expect(client).toEqual({ clientId: 'airtable-registered' });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://airtable.com/oauth2/v1/register');
    expect(sent[0].body).toEqual({
      client_name: 'Commonly (Airtable)',
      redirect_uris: [airtableCallback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: AIRTABLE_ENTRY.scopes.join(' '),
    });
    const stored = await Model.findOne({ entryId: 'airtable', current: true });
    expect(stored).toMatchObject({ issuer: 'https://airtable.com/oauth2/v1', clientSecretRef: null });
  });

  test('a CIMD entry never touches the registry or the AS', async () => {
    const fetch = registrationFetch([]);
    await expect(ensureDcrClient({ ...entry, client: 'cimd' }, metadata, callback, fetch))
      .rejects.toMatchObject({ code: 'client_registration_unsupported' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await Model.countDocuments({})).toBe(0);
  });

  // A client the vendor deleted fails on the vendor's own authorize page, which
  // never comes back here, so every new connect kept using it (F14). A member's
  // retry after a start that never finished is the sign this side gets.
  describe('a client the vendor no longer knows', () => {
    const answer = (status, body) => new Response(JSON.stringify(body), { status });
    // One stub for both the registration POST and the token endpoint ask.
    const vendor = (sent, tokenAnswer, registered = ['registered-1', 'registered-2']) => {
      let registrations = 0;
      return jest.fn(async (url, init) => {
        if (url === metadata.registration_endpoint) {
          const clientId = registered[registrations];
          registrations += 1;
          sent.push({ kind: 'register', clientId });
          return answer(201, { client_id: clientId, token_endpoint_auth_method: 'none', redirect_uris: [callback] });
        }
        sent.push({ kind: 'token', url, body: new URLSearchParams(String(init.body)) });
        return tokenAnswer();
      });
    };

    test('is asked about at the token endpoint and replaced, while rows it minted keep it', async () => {
      const sent = [];
      const fetch = vendor(sent, () => answer(401, { error: 'invalid_client' }));
      await ensureDcrClient(entry, metadata, callback, fetch);

      expect(await retireDcrClientIfUnknown(entry, metadata, 'registered-1', fetch)).toBe(true);

      const asked = sent.find((call) => call.kind === 'token');
      expect(asked.url).toBe(metadata.token_endpoint);
      expect(asked.body.get('grant_type')).toBe('authorization_code');
      expect(asked.body.get('client_id')).toBe('registered-1');
      expect(asked.body.get('redirect_uri')).toBe(callback);
      expect(asked.body.get('code')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(await Model.findOne({ clientId: 'registered-1' })).toMatchObject({ current: false, refusedAt: null });
      expect(await ensureDcrClient(entry, metadata, callback, fetch)).toEqual({ clientId: 'registered-2' });
      // Retired, not refused: a row it minted refreshes with it until the vendor refuses that.
      expect(await dcrClientForRow(entry, 'registered-1')).toEqual({ clientId: 'registered-1' });
    });

    test('is kept when the vendor still knows it, and asked about at most once an interval', async () => {
      const sent = [];
      const fetch = vendor(sent, () => answer(400, { error: 'invalid_grant' }));
      await ensureDcrClient(entry, metadata, callback, fetch);
      const now = new Date();

      expect(await retireDcrClientIfUnknown(entry, metadata, 'registered-1', fetch, now)).toBe(false);
      expect(await retireDcrClientIfUnknown(entry, metadata, 'registered-1', fetch, now)).toBe(false);
      expect(sent.filter((call) => call.kind === 'token')).toHaveLength(1);
      const later = new Date(now.getTime() + DCR_ASK_INTERVAL_MS + 1);
      expect(await retireDcrClientIfUnknown(entry, metadata, 'registered-1', fetch, later)).toBe(false);
      expect(sent.filter((call) => call.kind === 'token')).toHaveLength(2);
      expect(await Model.findOne({ clientId: 'registered-1' })).toMatchObject({ current: true });
    });

    test('is kept on any answer other than invalid_client', async () => {
      const replies = [
        () => answer(500, { error: 'server_error' }),
        () => answer(400, { error: 'invalid_request' }),
        () => answer(200, { access_token: 'never-for-a-made-up-code' }),
        () => new Response('not json', { status: 401 }),
        () => { throw new Error('connect ECONNREFUSED'); },
      ];
      const now = Date.now();
      for (const [i, reply] of replies.entries()) {
        await Model.deleteMany({});
        const fetch = vendor([], reply);
        await ensureDcrClient(entry, metadata, callback, fetch);
        // eslint-disable-next-line no-await-in-loop
        expect(await retireDcrClientIfUnknown(entry, metadata, 'registered-1', fetch, new Date(now + i))).toBe(false);
        expect(await Model.findOne({ clientId: 'registered-1' })).toMatchObject({ current: true });
      }
    });

    test('only the current client is asked about', async () => {
      const sent = [];
      const fetch = vendor(sent, () => answer(401, { error: 'invalid_client' }));
      await ensureDcrClient(entry, metadata, callback, fetch);
      expect(await retireDcrClientIfUnknown(entry, metadata, 'some-other-client', fetch)).toBe(false);
      expect(await retireDcrClientIfUnknown({ ...entry, client: 'cimd' }, metadata, 'registered-1', fetch)).toBe(false);
      expect(sent.filter((call) => call.kind === 'token')).toHaveLength(0);
    });

    test('an admin can retire an entry\'s current client by hand', async () => {
      const sent = [];
      const fetch = vendor(sent, () => answer(400, { error: 'invalid_grant' }));
      await ensureDcrClient(entry, metadata, callback, fetch);

      expect(await retireCurrentDcrClient(entry)).toBe(true);
      expect(await retireCurrentDcrClient(entry)).toBe(false);
      expect(await ensureDcrClient(entry, metadata, callback, fetch)).toEqual({ clientId: 'registered-2' });
      expect(await dcrClientForRow(entry, 'registered-1')).toEqual({ clientId: 'registered-1' });
    });
  });
});
