// TASK-782: the callback's reach step, beside D248's access step and on the same
// harness (copied from hostedMcpConnect.accessStep.test.js), in its own file for
// the same per-IP rate-limit reason.
// TASK-172 slice 3: the callback. The vendor is a stub and the row is a mock,
// so every arm here is about the DECISION the callback makes — which state it
// will spend, what it does with a subject that changed, and what it leaves on
// the row — rather than about Linear.
// TASK-253: production vendor requests go through the outbound guard
// (services/hostedVendorFetch). These arms stub the vendor at global.fetch, so
// the guarded transport is mapped back to it, read at call time; the guard's
// own rules are tested in outboundUrlGuard.vendorEndpoint.test.js.
jest.mock('../../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: (...args) => global.fetch(...args),
}));

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
  ingestIngressRateLimit: (_req, _res, next) => next(),
  ingestIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../../services/hostedMcpDcrRegistry', () => ({
  ensureDcrClient: jest.fn(),
  dcrClientForRow: jest.fn(),
  refuseDcrClient: jest.fn(),
  // The real classifier: which refusals mean the vendor doesn't know the client.
  refusalNamesUnknownClient: jest.requireActual('../../../services/hostedMcpDcrRegistry').refusalNamesUnknownClient,
}));

jest.mock('../../../services/connectorSecrets', () => ({
  put: jest.fn(),
  get: jest.fn(),
  revoke: jest.fn(),
}));

jest.mock('../../../services/roomGrantService', () => ({
  revokeConnectionGrants: jest.fn(),
}));

jest.mock('../../../services/hostedMcpToolDefinitions', () => ({
  forgetHostedMcpDrift: jest.fn(),
}));

const express = require('express');
const request = require('supertest');

const connectRoutes = require('../../../routes/hostedMcpConnect');
const Integration = require('../../../models/Integration');
const connectorSecrets = require('../../../services/connectorSecrets');
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
  status: 'pending',
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
  FIXTURE_ENTRY.client = 'cimd';
  delete FIXTURE_ENTRY.revoke.endpoint;
  connectorSecrets.get.mockReset();
  connectorSecrets.put.mockReset();
  connectorSecrets.revoke.mockReset();
  intake.discoverAuthorizationServer.mockResolvedValue({
    // §3.3's required claim, so the stub matches what real discovery returns.
    issuer: 'https://mcp.linear.app',
    authorization_endpoint: 'https://mcp.linear.app/authorize',
    token_endpoint: TOKEN_ENDPOINT,
    // A revoke goes only to the endpoint the issuer advertises (TASK-252), so the
    // stub advertises the one the revoking arms pin, as the real vendors do.
    revocation_endpoint: 'https://mcp.linear.app/revoke',
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
    .mockResolvedValueOnce({ _id: 'row-1' })
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
  const extraScopes = url.searchParams.getAll('extraScope');
  const next = url.searchParams.get('next');
  if (next) result.next = next;
  if (entryId) result.entryId = entryId;
  if (revokeAt) result.revokeAt = revokeAt;
  if (extraScopes.length) result.extraScopes = extraScopes;
  return result;
};

describe('hosted-mcp connect: callback reach step (TASK-782)', () => {
  afterEach(() => {
    delete FIXTURE_ENTRY.reachProbe;
    delete FIXTURE_ENTRY.accessPage;
    delete FIXTURE_ENTRY.needsAccessSetup;
  });

  const reachWrite = () => Integration.updateOne.mock.calls
    .find(([, update]) => update?.$set?.['config.reach']);

  it('a connection that sees no projects says so on return and keeps the answer on the row', async () => {
    FIXTURE_ENTRY.reachProbe = jest.fn().mockResolvedValue({ projects: 0 });
    Integration.updateOne.mockResolvedValue({ modifiedCount: 1 });
    expect(outcome(await callback())).toEqual({
      status: 302, hostedMcp: 'connected', code: null, entryId: 'linear', next: 'reach',
    });
    expect(FIXTURE_ENTRY.reachProbe).toHaveBeenCalledWith('access-1');
    const [filter, update] = reachWrite();
    // Bound to this callback's own pair, so a newer connect's row is never stamped.
    expect(filter).toEqual({ _id: 'row-1', 'config.credentialRef': 'ref-access' });
    expect(update.$set['config.reach']).toEqual({ projects: 0, checkedAt: expect.any(Date) });
  });

  it('every new pair clears the old answer first', async () => {
    FIXTURE_ENTRY.reachProbe = jest.fn().mockResolvedValue(null);
    await callback();
    const published = Integration.findOneAndUpdate.mock.calls
      .find(([, update]) => update?.$set?.status === 'connected');
    expect(published[1].$set['config.reach']).toBeNull();
  });

  it('a connection that sees projects records them and returns as before', async () => {
    FIXTURE_ENTRY.reachProbe = jest.fn().mockResolvedValue({ projects: 2 });
    Integration.updateOne.mockResolvedValue({ modifiedCount: 1 });
    expect(outcome(await callback())).toEqual({ status: 302, hostedMcp: 'connected', code: null });
    expect(reachWrite()[1].$set['config.reach']).toEqual({ projects: 2, checkedAt: expect.any(Date) });
  });

  it.each([
    ['an unknown answer', () => jest.fn().mockResolvedValue(null)],
    ['a failed probe', () => jest.fn().mockRejectedValue(new Error('timeout'))],
    ['a malformed answer', () => jest.fn().mockResolvedValue({ projects: -1 })],
  ])('%s warns about nothing and writes nothing', async (_name, probe) => {
    FIXTURE_ENTRY.reachProbe = probe();
    expect(outcome(await callback())).toEqual({ status: 302, hostedMcp: 'connected', code: null });
    expect(reachWrite()).toBeUndefined();
  });

  it('a failed write does not warn', async () => {
    FIXTURE_ENTRY.reachProbe = jest.fn().mockResolvedValue({ projects: 0 });
    Integration.updateOne.mockRejectedValue(new Error('mongo down'));
    expect(outcome(await callback())).toEqual({ status: 302, hostedMcp: 'connected', code: null });
  });

  it('the access step wins: nothing is reachable until access is set up', async () => {
    FIXTURE_ENTRY.accessPage = 'https://github.com/apps/commonly-connect/installations/new';
    FIXTURE_ENTRY.needsAccessSetup = jest.fn().mockResolvedValue(true);
    FIXTURE_ENTRY.reachProbe = jest.fn().mockResolvedValue({ projects: 0 });
    expect(outcome(await callback()).next).toBe('access');
    expect(FIXTURE_ENTRY.reachProbe).not.toHaveBeenCalled();
  });
});
