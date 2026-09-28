// TASK-172 slice 3: the Client ID Metadata Document, served from the instance
// (docs/plans/hosted-mcp-connection-scope.md §4). The catalogue is a fixture
// here and the lookup is the real one, so the arms measure the route rather
// than a mock of it.
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

const request = require('supertest');
const express = require('express');

const connectRoutes = require('../../../routes/hostedMcpConnect');
const { hostedMcpApiBase } = require('../../../services/hostedMcpIntakeService');

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

const DOC_URL = '/connect/hosted-mcp/linear/client-metadata';

describe('hosted-mcp connect: the client metadata document', () => {
  it('serves the document for a listed entry, at the URL its client_id names', async () => {
    const res = await request(app).get(DOC_URL);
    expect(res.status).toBe(200);
    // The path the AS fetches and the client_id inside must be the same URL, or
    // the AS resolves a client id to a document describing a different client.
    expect(res.body.client_id).toBe(
      `${hostedMcpApiBase()}/api/integrations/connect/hosted-mcp/linear/client-metadata`,
    );
    expect(res.body.redirect_uris).toEqual([
      `${hostedMcpApiBase()}/api/integrations/connect/hosted-mcp/linear/callback`,
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
