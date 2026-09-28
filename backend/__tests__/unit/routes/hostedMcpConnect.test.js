// TASK-172 slice 3: hosted-MCP intake — the Client ID Metadata Document and the
// start route (docs/plans/hosted-mcp-connection-scope.md §4). The catalogue is a
// fixture, the lookup and the builders are the real ones, and the authorization
// server is a stub: that is the ruling's boundary, every step except the live
// lines being measurable without a vendor account.
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

let mockAuthedUser = { id: 'user-1' };
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = mockAuthedUser;
  next();
});

jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({ findOneAndUpdate: jest.fn() }));

const request = require('supertest');
const express = require('express');

const connectRoutes = require('../../../routes/hostedMcpConnect');
const Integration = require('../../../models/Integration');
const { undeclaredPaths } = require('../../utils/schemaPathGuard');
const intake = require('../../../services/hostedMcpIntakeService');

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

const DOC_URL = '/connect/hosted-mcp/linear/client-metadata';
const AS_METADATA = {
  authorization_endpoint: 'https://mcp.linear.app/authorize',
  token_endpoint: 'https://mcp.linear.app/token',
};

const start = (entryId = 'linear') => request(app).post(`/connect/hosted-mcp/${entryId}/start`);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthedUser = { id: 'user-1' };
  intake.discoverAuthorizationServer.mockResolvedValue(AS_METADATA);
  Integration.findOneAndUpdate.mockResolvedValue({ _id: 'integration-1' });
});

describe('hosted-mcp connect: the client metadata document', () => {
  it('serves the document for a listed entry, at the URL its client_id names', async () => {
    const res = await request(app).get(DOC_URL);
    expect(res.status).toBe(200);
    // The path the AS fetches and the client_id inside must be the same URL, or
    // the AS resolves a client id to a document describing a different client.
    // Literal, not read back from `hostedMcpApiBase()`: an expectation computed
    // by the function under test moves with it and witnesses nothing.
    expect(res.body.client_id).toBe(
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
    );
    expect(res.body.redirect_uris).toEqual([
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/callback',
    ]);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(res.body.scope).toBe('read openid');
  });

  it('404s an entry that is not in the catalogue instead of serving an empty client', async () => {
    const res = await request(app).get('/connect/hosted-mcp/notion/client-metadata');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_entry' });
    // Positive control for the arm above: the same request shape against the
    // listed entry is a 200, so the 404 is the lookup and not the path.
    const control = await request(app).get(DOC_URL);
    expect(control.status).toBe(200);
  });

  it('is the same document for every caller, because the client is the instance', async () => {
    const first = await request(app).get(DOC_URL).set('Authorization', 'Bearer someone');
    const second = await request(app).get(DOC_URL);
    expect(first.body).toEqual(second.body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('carries no secret, because a public client has none to carry', async () => {
    const res = await request(app).get(DOC_URL);
    // A CIMD client is public by definition; a `client_secret` here would be a
    // secret the vendor was told to trust and nobody could rotate.
    expect(res.body.client_secret).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual([
      'client_id', 'client_name', 'grant_types', 'redirect_uris',
      'response_types', 'scope', 'token_endpoint_auth_method',
    ].sort());
  });
});

describe('hosted-mcp connect: start', () => {
  it('sends the member to the vendor with the entry\'s own resource and a fresh state', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe(AS_METADATA.authorization_endpoint);
    expect(url.searchParams.get('resource')).toBe(FIXTURE_ENTRY.resource);
    expect(url.searchParams.get('client_id')).toBe(
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/callback',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    // The state we redirect with must be the one the row can be found by
    // afterwards: a redirect naming a state no row holds is a callback that can
    // never resolve.
    const [, update] = Integration.findOneAndUpdate.mock.calls[0];
    expect(url.searchParams.get('state')).toBe(update.$set['config.pendingAuth'].state);
    expect(update.$set['config.pendingAuth'].codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(update.$set['config.pendingAuth'].expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(new Date(res.body.expiresAt).getTime()).toBe(update.$set['config.pendingAuth'].expiresAt.getTime());
    expect(typeof res.body.expiresAt).toBe('string');
  });

  it('reuses one row per person per entry, rather than inserting a second', async () => {
    await start();
    const [filter, update, options] = Integration.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ type: 'hosted-mcp', createdBy: 'user-1', 'config.entryId': 'linear' });
    expect(options.upsert).toBe(true);
    // The insert half must name the same keys the filter does, or the row that
    // gets created is found by nobody on the next connect.
    expect(update.$setOnInsert).toMatchObject({
      type: 'hosted-mcp',
      scope: 'user',
      status: 'pending',
      createdBy: 'user-1',
      'config.entryId': 'linear',
    });
    expect(update.$set['config.intake']).toBe('oauth');
    // The same declaration check the callback arm makes: `config` is a strict
    // subdocument, so a key named here but not declared is dropped in silence
    // and leaves a row nobody can find (or a state nothing can spend).
    const Deployed = jest.requireActual('../../../models/Integration').default;
    const written = [...Object.keys(update.$set), ...Object.keys(update.$setOnInsert)];
    expect(undeclaredPaths(Deployed.schema, written)).toEqual([]);
  });

  it('discovers the entry\'s own issuer, not a literal', async () => {
    await start();
    expect(intake.discoverAuthorizationServer).toHaveBeenCalledWith(FIXTURE_ENTRY.issuer);
  });

  it('refuses an unknown entry without probing a vendor for it', async () => {
    const res = await start('notion');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_entry' });
    expect(intake.discoverAuthorizationServer).not.toHaveBeenCalled();
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('writes no pending row when the vendor is unreachable', async () => {
    intake.discoverAuthorizationServer.mockRejectedValue(
      Object.assign(new Error('boom'), { code: 'issuer_unreachable' }),
    );
    const res = await start();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'issuer_unreachable' });
    // A pending row whose nonce can never be spent would show the connector as
    // mid-connect on the page forever.
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured pre-registered client before it touches the vendor', async () => {
    const entries = jest.requireMock('../../../integrations/hostedMcp/entries');
    entries.HOSTED_MCP_ENTRIES.push({ ...FIXTURE_ENTRY, id: 'notion', client: 'pre-registered' });
    const res = await start('notion');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'client_not_configured' });
    expect(intake.discoverAuthorizationServer).not.toHaveBeenCalled();
    entries.HOSTED_MCP_ENTRIES.pop();
  });

  it('requires a person, because it is the person who will be consenting', async () => {
    mockAuthedUser = undefined;
    const res = await start();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'authentication_required' });
    expect(Integration.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
