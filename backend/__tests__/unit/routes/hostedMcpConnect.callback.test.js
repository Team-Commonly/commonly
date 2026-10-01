// TASK-172 slice 3: the callback. The vendor is a stub and the row is a mock,
// so every arm here is about the DECISION the callback makes — which state it
// will spend, what it does with a subject that changed, and what it leaves on
// the row — rather than about Linear.
const FIXTURE_ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: { page: 'https://linear.app/settings/security' },
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
    // The callback copies this off the entry onto the row, so the partial mock
    // has to carry it: an unforwarded accessor reads as `undefined` and throws
    // at the write rather than at the import.
    hostedMcpRevokeTarget: actual.hostedMcpRevokeTarget,
  };
});

jest.mock('../../../services/hostedMcpIntakeService', () => {
  const actual = jest.requireActual('../../../services/hostedMcpIntakeService');
  return { ...actual, discoverAuthorizationServer: jest.fn() };
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../services/connectorSecrets', () => ({
  put: jest.fn(),
  get: jest.fn(),
  revoke: jest.fn(),
}));

jest.mock('../../../services/roomGrantService', () => ({
  revokeConnectionGrants: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const connectRoutes = require('../../../routes/hostedMcpConnect');
const Integration = require('../../../models/Integration');
const connectorSecrets = require('../../../services/connectorSecrets');
const { revokeConnectionGrants } = require('../../../services/roomGrantService');
const { undeclaredPaths } = require('../../utils/schemaPathGuard');
const intake = require('../../../services/hostedMcpIntakeService');

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

const TOKEN_ENDPOINT = 'https://mcp.linear.app/token';
const idToken = (sub) => [
  Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub })).toString('base64url'),
  'sig',
].join('.');

const BROWSER_COOKIE = 'commonly_hosted_mcp_nonce=browser-1';

const callback = (query = 'state=st-1&code=code-1', cookie = BROWSER_COOKIE, entryId = 'linear') => {
  const sent = request(app).get(`/connect/hosted-mcp/${entryId}/callback?${query}`);
  // The browser that started the flow sends this; `null` is the browser that
  // did not, which is the whole point of the cookie.
  return cookie === null ? sent : sent.set('Cookie', cookie);
};

/**
 * A row as the database would hand it back on a reconnect.
 *
 * The argument is a set of `config` fields, because that is where the
 * credential half actually lives: `config` is a strict subdocument, and a
 * fixture that spread `credentialRef` across the top level would let the
 * handler read the wrong shape and still look green (measured 2026-09-28 —
 * the same class of miss as the unprefixed `$set` beside it).
 */
const storedRow = (config = {}) => ({
  _id: 'row-1',
  createdBy: 'user-1',
  config: {
    entryId: 'linear',
    pendingAuth: {
      state: 'st-1',
      codeVerifier: 'verifier-1',
      expiresAt: new Date(Date.now() + 60 * 1000),
      browserNonce: 'browser-1',
    },
    ...config,
  },
});

const okTokenResponse = {
  ok: true,
  json: async () => ({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: 'read',
    id_token: idToken('acct-1'),
  }),
};

beforeEach(() => {
  jest.clearAllMocks();
  delete FIXTURE_ENTRY.revoke.endpoint;
  connectorSecrets.get.mockReset();
  connectorSecrets.put.mockReset();
  connectorSecrets.revoke.mockReset();
  intake.discoverAuthorizationServer.mockResolvedValue({
    // §3.3's required claim, so the stub matches what real discovery returns.
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: TOKEN_ENDPOINT,
  });
  connectorSecrets.put.mockResolvedValueOnce('ref-access').mockResolvedValueOnce('ref-refresh');
  global.fetch = jest.fn().mockResolvedValue(okTokenResponse);
  setStoredRow();
});

/**
 * One row, seen twice: by the lookup and by the atomic claim that hands back
 * the pre-image. Setting only the lookup would leave the claim's copy bare, and
 * an arm about what the pre-image CONTAINED would pass on the empty one.
 */
const setStoredRow = (overrides = {}) => {
  const row = storedRow(overrides);
  Integration.findOne.mockResolvedValue(row);
  Integration.findOneAndUpdate.mockReset();
  Integration.findOneAndUpdate
    .mockResolvedValueOnce(row)
    .mockResolvedValueOnce({ _id: 'row-1' });
};

const outcome = (res) => {
  const url = new URL(res.headers.location, 'https://commonly.me');
  const result = {
    status: res.status,
    hostedMcp: url.searchParams.get('hostedMcp'),
    code: url.searchParams.get('code'),
  };
  const entryId = url.searchParams.get('entryId');
  const revokeAt = url.searchParams.get('revokeAt');
  if (entryId) result.entryId = entryId;
  if (revokeAt) result.revokeAt = revokeAt;
  return result;
};

describe('hosted-mcp connect: callback', () => {
  it('the callback records the client that minted the pair', async () => {
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'connected', code: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    // The exchange carries the same deadline every other vendor call does, or a
    // silently accepting vendor leaves the browser on a spinner.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_id')).toBe(intake.hostedMcpClientMetadataUrl('linear'));
    // §4: the resource rides the token request too, or the AS issues a token
    // that reaches the vendor's default audience rather than this server.
    expect(body.get('resource')).toBe(FIXTURE_ENTRY.resource);
    expect(body.get('redirect_uri')).toBe(intake.hostedMcpCallbackUrl('linear'));

    expect(connectorSecrets.put).toHaveBeenCalledWith('row-1', expect.objectContaining({ kind: 'hosted-mcp-access-token' }), 'access-1');
    expect(connectorSecrets.put).toHaveBeenCalledWith('row-1', expect.objectContaining({ kind: 'hosted-mcp-refresh-token' }), 'refresh-1');
    const [, update] = Integration.findOneAndUpdate.mock.calls[1];
    expect(update.$set).toMatchObject({
      status: 'connected',
      'config.clientId': intake.hostedMcpClientMetadataUrl('linear'),
      'config.credentialRef': 'ref-access',
      'config.refreshTokenRef': 'ref-refresh',
      'config.grantedScope': 'read',
      'config.providerSubject': 'acct-1',
      'config.refreshGeneration': 0,
      'config.expiresAt': expect.any(Date),
    });
    // Every path this write names must be DECLARED. `config` is a strict
    // subdocument, so an unprefixed `credentialRef` matches nothing above and is
    // dropped by the real schema in silence: the row would come back `connected`
    // holding no token, and this mock would never say so. Measured against a
    // real mongod before this arm existed — all six `config.*` fields vanished.
    const Deployed = jest.requireActual('../../../models/Integration').default;
    expect(undeclaredPaths(Deployed.schema, Object.keys(update.$set))).toEqual([]);
    const committedExpiry = new Date(update.$set['config.expiresAt']).getTime();
    // `expires_in` is seconds, and a reader that treated it as milliseconds
    // would show this credential as long expired.
    expect(committedExpiry).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(committedExpiry).toBeLessThan(Date.now() + 61 * 60 * 1000);
    // The pending state is gone whichever way the flow went, so a replay of the
    // state finds no row and cannot reach the exchange a second time.
    expect(Integration.findOneAndUpdate.mock.calls[0][1].$unset).toEqual({ 'config.pendingAuth': 1 });
  });

  it('exchanges a pre-registered callback with instance credentials while retaining PKCE', async () => {
    const originalEntry = { ...FIXTURE_ENTRY };
    const originalId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    const originalSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    Object.assign(FIXTURE_ENTRY, {
      id: 'google-calendar',
      issuer: 'https://accounts.google.test',
      client: 'pre-registered',
      resource: 'https://calendar.google.test/mcp',
    });
    process.env.GOOGLE_CALENDAR_CLIENT_ID = 'registered-client';
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'registered-secret';
    intake.discoverAuthorizationServer.mockResolvedValue({
      issuer: FIXTURE_ENTRY.issuer,
      authorization_endpoint: 'https://accounts.google.test/authorize',
      token_endpoint: 'https://accounts.google.test/token',
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
    });
    setStoredRow({ entryId: 'google-calendar' });

    try {
      const res = await callback('state=st-1&code=code-1', BROWSER_COOKIE, 'google-calendar');

      expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'connected', code: null });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://accounts.google.test/token');
      expect(init.headers.Authorization).toBe(
        `Basic ${Buffer.from('registered-client:registered-secret').toString('base64')}`,
      );
      const body = new URLSearchParams(String(init.body));
      expect(body.get('code_verifier')).toBe('verifier-1');
      expect(body.get('resource')).toBe(FIXTURE_ENTRY.resource);
      expect(body.get('client_id')).toBeNull();
      expect(body.get('client_secret')).toBeNull();

      const [, update] = Integration.findOneAndUpdate.mock.calls[1];
      expect(update.$set['config.clientId']).toBe('registered-client');
      expect(JSON.stringify(update.$set)).not.toContain('registered-secret');
    } finally {
      Object.assign(FIXTURE_ENTRY, originalEntry);
      if (originalId === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
      else process.env.GOOGLE_CALENDAR_CLIENT_ID = originalId;
      if (originalSecret === undefined) delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
      else process.env.GOOGLE_CALENDAR_CLIENT_SECRET = originalSecret;
    }
  });

  it('refuses a browser that carries no nonce cookie, before it reads any row', async () => {
    const res = await callback('state=st-1&code=code-1', null);
    expect(outcome(res).code).toBe('invalid_state');
    // "Before it reads any row" is a claim about ORDER, so it is asserted: the
    // refusal must not be a lookup whose answer happens to be no, or a request
    // carrying a state it was sent costs us a row read per attempt.
    expect(Integration.findOne).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses a cookie that belongs to another flow, without spending this one', async () => {
    const res = await callback('state=st-1&code=code-1', 'commonly_hosted_mcp_nonce=browser-2');
    expect(outcome(res).code).toBe('browser_mismatch');
    // NOT consumed: a wrong browser must not be able to burn a flow that
    // belongs to somebody else, which is the reason this check sits outside the
    // claim rather than inside its filter.
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    // Positive control, same request with its own cookie: the arm cannot pass by
    // refusing every callback in sight.
    const control = await callback();
    expect(outcome(control).hostedMcp).toBe('connected');
  });

  it('refuses when the row holds no nonce at all, so a dropped field is not an open door', async () => {
    // This is what an UNDECLARED `browserNonce` on the strict subdocument looks
    // like from the handler's side: the compare reads `undefined`, and the arm
    // that says "a mismatch refuses" is the one that catches it.
    setStoredRow({
      pendingAuth: {
        state: 'st-1',
        codeVerifier: 'verifier-1',
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    });
    const res = await callback();
    expect(outcome(res).code).toBe('browser_mismatch');
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses a state it did not issue, without spending a code on it', async () => {
    Integration.findOne.mockResolvedValue(null);
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a state whose nonce has expired, before it claims anything', async () => {
    Integration.findOne.mockResolvedValue(storedRow({
      pendingAuth: {
        state: 'st-1',
        codeVerifier: 'verifier-1',
        expiresAt: new Date(Date.now() - 1000),
      },
    }));
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'state_expired' });
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a state another delivery has already spent, and exchanges nothing', async () => {
    // The claim is atomic, so the loser of the race gets null back.
    Integration.findOneAndUpdate.mockReset();
    Integration.findOneAndUpdate.mockResolvedValueOnce(null);
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'state_consumed' });
    const [filter, update, options] = Integration.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ 'config.pendingAuth.state': 'st-1' });
    expect(update.$unset).toEqual({ 'config.pendingAuth': 1 });
    expect(options.new).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('accepts a callback that carries no iss at all, because RFC 9207 is optional', async () => {
    // The arm below refuses a DIFFERENT issuer. Without this one, a handler that
    // demanded the parameter would look green: every other callback arm happens
    // to be caught as collateral, none of them NAMES the rule.
    const res = await callback('state=st-1&code=code-1');
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'connected', code: null });
  });

  it('refuses an iss that is not the entry\'s issuer', async () => {
    const res = await callback('state=st-1&code=code-1&iss=https%3A%2F%2Fevil.example');
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'issuer_mismatch' });
    expect(global.fetch).not.toHaveBeenCalled();
    // Positive control: the entry's own issuer is the same request accepted,
    // so the arm above refuses the VALUE and not the presence of the parameter.
    const control = await callback('state=st-1&code=code-1&iss=https%3A%2F%2Fmcp.linear.app');
    expect(outcome(control).hostedMcp).toBe('connected');
  });

  it('revokes the row\'s grants when a reconnect brings a different account', async () => {
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
    });
    const res = await callback();
    expect(outcome(res).hostedMcp).toBe('connected');
    expect(revokeConnectionGrants).toHaveBeenCalledWith({
      connection: expect.objectContaining({ _id: 'row-1' }),
      revokedBy: 'user-1',
    });
    // ORDER is the claim §2 makes: the old grant is gone before the new pair
    // exists, or a grant could be made against the new account's reach while
    // the old one is still live.
    const revokeOrder = revokeConnectionGrants.mock.invocationCallOrder[0];
    expect(revokeOrder).toBeLessThan(connectorSecrets.put.mock.invocationCallOrder[0]);
  });

  it('a reconnect as a different provider account withdraws the old refresh token before either new secret overwrites it', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
      clientId: intake.hostedMcpClientMetadataUrl('linear'),
    });
    const secretValues = new Map([
      ['ref-old-access', 'old-access-token'],
      ['ref-old-refresh', 'old-refresh-token'],
    ]);
    connectorSecrets.get.mockImplementation(async (ref) => secretValues.get(String(ref)));
    connectorSecrets.put.mockReset();
    connectorSecrets.put.mockImplementation(async (_rowId, kind, value) => {
      const ref = kind.kind === 'hosted-mcp-refresh-token' ? 'ref-old-refresh' : 'ref-old-access';
      secretValues.set(ref, value);
      return ref;
    });
    global.fetch.mockReset();
    global.fetch
      .mockResolvedValueOnce(okTokenResponse)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await callback();

    expect(outcome(res).hostedMcp).toBe('connected');
    expect(outcome(res).revokeAt).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe(FIXTURE_ENTRY.revoke.endpoint);
    const revokeBody = new URLSearchParams(String(global.fetch.mock.calls[1][1].body));
    expect(revokeBody.get('token')).toBe('old-refresh-token');
    expect(revokeBody.get('token')).not.toBe('refresh-1');
    expect(revokeBody.get('token_type_hint')).toBe('refresh_token');
    // This is the ordering contract: connectorSecrets.put updates the old ref
    // in place, so moving the get below either put sends the newly authorized
    // token to the revocation endpoint instead.
    expect(connectorSecrets.get.mock.invocationCallOrder[0])
      .toBeLessThan(connectorSecrets.put.mock.invocationCallOrder[0]);
    expect(secretValues.get('ref-old-refresh')).toBe('refresh-1');
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the stored subject is missing', { credentialRef: 'ref-old-access', refreshTokenRef: 'ref-old-refresh' }, idToken('acct-new')],
    ['the exchanged subject is missing', {
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
    }, undefined],
  ])('a reconnect whose subjects cannot be compared sends nothing and names the revoke page when %s', async (_label, oldConfig, newIdToken) => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow(oldConfig);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        ...(newIdToken ? { id_token: newIdToken } : {}),
      }),
    });

    const res = await callback();

    expect(outcome(res)).toEqual({
      status: 302,
      hostedMcp: 'connected',
      code: null,
      entryId: 'linear',
      revokeAt: FIXTURE_ENTRY.revoke.page,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(connectorSecrets.get).not.toHaveBeenCalled();
    expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('a refused provider withdrawal still finishes the reconnect and names the revoke page', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
      clientId: intake.hostedMcpClientMetadataUrl('linear'),
    });
    connectorSecrets.get.mockResolvedValue('old-refresh-token');
    global.fetch.mockReset();
    global.fetch
      .mockResolvedValueOnce(okTokenResponse)
      .mockResolvedValueOnce({ ok: false, status: 503 });

    const res = await callback();

    expect(outcome(res)).toEqual({
      status: 302,
      hostedMcp: 'connected',
      code: null,
      entryId: 'linear',
      revokeAt: FIXTURE_ENTRY.revoke.page,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('an unreachable provider withdrawal still finishes the reconnect and names the revoke page', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
      clientId: intake.hostedMcpClientMetadataUrl('linear'),
    });
    connectorSecrets.get.mockResolvedValue('old-refresh-token');
    global.fetch.mockReset();
    global.fetch
      .mockResolvedValueOnce(okTokenResponse)
      .mockRejectedValueOnce(new Error('socket hang up'));

    const res = await callback();

    expect(outcome(res)).toEqual({
      status: 302,
      hostedMcp: 'connected',
      code: null,
      entryId: 'linear',
      revokeAt: FIXTURE_ENTRY.revoke.page,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('an unreadable old token does not stop reconnect and names the revoke page', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
      clientId: intake.hostedMcpClientMetadataUrl('linear'),
    });
    connectorSecrets.get.mockRejectedValue(new Error('connector_secret_key_missing'));

    const res = await callback();

    expect(outcome(res)).toEqual({
      status: 302,
      hostedMcp: 'connected',
      code: null,
      entryId: 'linear',
      revokeAt: FIXTURE_ENTRY.revoke.page,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
  });

  it('a reconnect whose old pair was minted by another client sends no token and names the revoke page', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-old',
      clientId: 'retired-client-id',
    });

    const res = await callback();

    expect(outcome(res)).toEqual({
      status: 302,
      hostedMcp: 'connected',
      code: null,
      entryId: 'linear',
      revokeAt: FIXTURE_ENTRY.revoke.page,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(connectorSecrets.get).not.toHaveBeenCalled();
    expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
  });

  it('uses the old access token when the row has no refresh-token reference', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      providerSubject: 'acct-old',
      clientId: intake.hostedMcpClientMetadataUrl('linear'),
    });
    connectorSecrets.get.mockResolvedValue('old-access-token');
    global.fetch.mockReset();
    global.fetch
      .mockResolvedValueOnce(okTokenResponse)
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await callback();

    expect(outcome(res).hostedMcp).toBe('connected');
    expect(outcome(res).revokeAt).toBeUndefined();
    const revokeBody = new URLSearchParams(String(global.fetch.mock.calls[1][1].body));
    expect(revokeBody.get('token')).toBe('old-access-token');
    expect(revokeBody.get('token_type_hint')).toBe('access_token');
  });

  it('hands the person the revoke page when a different-account reconnect has no vendor endpoint', async () => {
    setStoredRow({
      credentialRef: 'ref-old-access',
      providerSubject: 'acct-old',
      clientId: intake.hostedMcpClientMetadataUrl('linear'),
    });

    const res = await callback();

    expect(outcome(res)).toEqual({
      status: 302,
      hostedMcp: 'connected',
      code: null,
      entryId: 'linear',
      revokeAt: FIXTURE_ENTRY.revoke.page,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(connectorSecrets.get).not.toHaveBeenCalled();
    expect(connectorSecrets.put).toHaveBeenCalledTimes(2);
  });

  it('leaves the grants alone when the same account reconnects', async () => {
    FIXTURE_ENTRY.revoke.endpoint = 'https://mcp.linear.app/revoke';
    setStoredRow({
      credentialRef: 'ref-old-access',
      refreshTokenRef: 'ref-old-refresh',
      providerSubject: 'acct-1',
    });
    const res = await callback();
    expect(outcome(res).hostedMcp).toBe('connected');
    // Without this arm the one above passes on a callback that revokes on every
    // reconnect, which is a different defect wearing the same green tick.
    expect(revokeConnectionGrants).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(connectorSecrets.get).not.toHaveBeenCalled();
  });

  it('revokes the row\'s grants when neither side has a subject to compare', async () => {
    // The old row was written before a vendor issued ID tokens, and this one
    // still doesn't: two unknowns are not the same account.
    setStoredRow({ credentialRef: 'ref-old-access' });
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'access-1' }) });
    const res = await callback();
    expect(outcome(res).hostedMcp).toBe('connected');
    expect(revokeConnectionGrants).toHaveBeenCalled();
  });

  it('revokes the row\'s grants when the vendor issues no subject to compare', async () => {
    setStoredRow({
      credentialRef: 'ref-old-access',
      providerSubject: 'acct-old',
    });
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'access-1', refresh_token: 'refresh-1' }),
    });
    const res = await callback();
    expect(outcome(res).hostedMcp).toBe('connected');
    expect(revokeConnectionGrants).toHaveBeenCalled();
  });

  it('drops a refresh token the vendor no longer issues instead of keeping a dead one', async () => {
    setStoredRow({ refreshTokenRef: 'ref-old-refresh' });
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'access-1' }) });
    connectorSecrets.put.mockReset();
    connectorSecrets.put.mockResolvedValue('ref-access');
    const res = await callback();
    expect(outcome(res).hostedMcp).toBe('connected');
    expect(connectorSecrets.revoke).toHaveBeenCalledWith('ref-old-refresh');
    const [, update] = Integration.findOneAndUpdate.mock.calls[1];
    expect(update.$set['config.refreshTokenRef']).toBe(null);
  });

  it('refuses a callback carrying no state at all, before it looks for a row', async () => {
    const noState = await callback('code=code-1');
    expect(outcome(noState)).toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    const noCode = await callback('state=st-1');
    expect(outcome(noCode)).toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    // A lookup keyed on an empty state would match whatever a mock or a
    // permissive query returned, so the guard has to run before the lookup.
    expect(Integration.findOne).not.toHaveBeenCalled();
  });

  it('reports a refused exchange as a vendor outcome, not as a connected row', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'exchange_refused' });
    expect(connectorSecrets.put).not.toHaveBeenCalled();
    // The commit never ran: a row still carrying the old credential must not be
    // relabelled from a failed exchange.
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports an exchange that returned no token as incomplete, not as connected', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ scope: 'read' }) });
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'exchange_incomplete' });
    expect(connectorSecrets.put).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports an exchange that never arrived as unreachable, not as a refusal', async () => {
    global.fetch.mockRejectedValue(new Error('socket hang up'));
    const res = await callback();
    // A network failure and a refused grant send the person to different
    // actions — retry, or reconnect — so they cannot share a code.
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'exchange_unreachable' });
    expect(connectorSecrets.put).not.toHaveBeenCalled();
  });
});
