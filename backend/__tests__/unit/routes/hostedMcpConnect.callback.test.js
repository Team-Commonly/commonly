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
  revoke: 'https://mcp.linear.app/token',
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
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

const callback = (query = 'state=st-1&code=code-1') => (
  request(app).get(`/connect/hosted-mcp/linear/callback?${query}`)
);

/** A row as the database would hand it back on a reconnect. */
const storedRow = (overrides = {}) => ({
  _id: 'row-1',
  createdBy: 'user-1',
  config: {
    entryId: 'linear',
    pendingAuth: {
      state: 'st-1',
      codeVerifier: 'verifier-1',
      expiresAt: new Date(Date.now() + 60 * 1000),
    },
  },
  ...overrides,
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
  intake.discoverAuthorizationServer.mockResolvedValue({
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
  return { status: res.status, hostedMcp: url.searchParams.get('hostedMcp'), code: url.searchParams.get('code') };
};

describe('hosted-mcp connect: callback', () => {
  it('exchanges the code at the issuer\'s token endpoint and stores the pair', async () => {
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'connected', code: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    // §4: the resource rides the token request too, or the AS issues a token
    // that reaches the vendor's default audience rather than this server.
    expect(body.get('resource')).toBe(FIXTURE_ENTRY.resource);
    expect(body.get('redirect_uri')).toBe(intake.hostedMcpCallbackUrl('linear'));

    expect(connectorSecrets.put).toHaveBeenCalledWith('row-1', expect.objectContaining({ kind: 'hosted-mcp-access-token' }), 'access-1');
    expect(connectorSecrets.put).toHaveBeenCalledWith('row-1', expect.objectContaining({ kind: 'hosted-mcp-refresh-token' }), 'refresh-1');
    const [, update] = Integration.findOneAndUpdate.mock.calls[1];
    expect(update.$set).toMatchObject({
      status: 'connected',
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

  it('refuses a state it did not issue, without spending a code on it', async () => {
    Integration.findOne.mockResolvedValue(null);
    const res = await callback();
    expect(outcome(res)).toEqual({ status: 302, hostedMcp: 'error', code: 'invalid_state' });
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a state whose nonce has expired, before it claims anything', async () => {
    Integration.findOne.mockResolvedValue(storedRow({
      config: {
        entryId: 'linear',
        pendingAuth: {
          state: 'st-1',
          codeVerifier: 'verifier-1',
          expiresAt: new Date(Date.now() - 1000),
        },
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

  it('leaves the grants alone when the same account reconnects', async () => {
    setStoredRow({
      credentialRef: 'ref-old-access',
      providerSubject: 'acct-1',
    });
    const res = await callback();
    expect(outcome(res).hostedMcp).toBe('connected');
    // Without this arm the one above passes on a callback that revokes on every
    // reconnect, which is a different defect wearing the same green tick.
    expect(revokeConnectionGrants).not.toHaveBeenCalled();
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
    expect(update.$set.refreshTokenRef).toBeUndefined();
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
