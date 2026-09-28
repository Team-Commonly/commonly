// TASK-172 slice 3: intake — the client identity, the authorization request and
// PKCE (docs/plans/hosted-mcp-connection-scope.md §4). Nothing here reaches a
// vendor: the authorization server is a stub the test passes in, which is the
// ruling's point that every step except the live lines is testable without one.
const {
  HOSTED_MCP_PENDING_TTL_MS,
  HostedMcpClientError,
  buildAuthorizeUrl,
  buildClientMetadataDocument,
  buildRefreshBody,
  buildTokenExchangeBody,
  createPkcePair,
  createStateNonce,
  discoverAuthorizationServer,
  resolvedClientId,
} = require('../../../services/hostedMcpIntakeService');

const API = 'https://api.example.test';
const RESOURCE = 'https://mcp.linear.app/mcp';

const entry = (over) => Object.assign({
  id: 'linear',
  title: 'Linear',
  resource: RESOURCE,
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: 'https://mcp.linear.app/token',
  tools: [],
}, over);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const AS_METADATA = {
  authorization_endpoint: 'https://mcp.linear.app/authorize',
  token_endpoint: 'https://mcp.linear.app/token',
};

describe('hosted-mcp intake: the client metadata document', () => {
  it('names itself as the client id, so nothing is registered at the vendor', () => {
    const doc = buildClientMetadataDocument(entry(), API);
    expect(doc.client_id).toBe(
      `${API}/api/integrations/connect/hosted-mcp/linear/client-metadata`,
    );
    // The document's own client_id is the URL it is served at: a reader that
    // fetched it and a reader that read this field must agree, or an AS sees a
    // client id that resolves to a document naming a different one.
    const served = buildClientMetadataDocument(entry(), API);
    expect(doc.client_id).toBe(served.client_id);
  });

  it('registers exactly one redirect URI, and the path names the entry', () => {
    const doc = buildClientMetadataDocument(entry(), API);
    expect(doc.redirect_uris).toHaveLength(1);
    expect(doc.redirect_uris[0]).toBe(
      `${API}/api/integrations/connect/hosted-mcp/linear/callback`,
    );
  });

  it('is a public client: no secret to steal, and the scopes are the entry\'s', () => {
    const doc = buildClientMetadataDocument(entry(), API);
    expect(doc.token_endpoint_auth_method).toBe('none');
    expect(doc.scope).toBe('read openid');
    expect(doc.grant_types).toContain('authorization_code');
    expect(doc.grant_types).toContain('refresh_token');
  });

  it('is one document per entry, not one per instance', () => {
    const a = buildClientMetadataDocument(entry({ id: 'linear' }), API);
    const b = buildClientMetadataDocument(entry({ id: 'notion', title: 'Notion' }), API);
    expect(a.client_id).not.toBe(b.client_id);
    expect(a.redirect_uris[0]).not.toBe(b.redirect_uris[0]);
  });
});

describe('hosted-mcp intake: which client id we present', () => {
  it('presents the metadata URL for a CIMD entry', () => {
    expect(resolvedClientId(entry(), {})).toBe(
      'https://api.commonly.me/api/integrations/connect/hosted-mcp/linear/client-metadata',
    );
  });

  it('reads a pre-registered client from the entry\'s own key', () => {
    expect(resolvedClientId(
      entry({ id: 'my-entry', client: 'pre-registered' }),
      { MY_ENTRY_CLIENT_ID: 'the-registered-id' },
    )).toBe('the-registered-id');
  });

  it('refuses a pre-registered entry whose key is unset rather than inventing one', () => {
    let thrown;
    try {
      resolvedClientId(entry({ client: 'pre-registered' }), {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostedMcpClientError);
    expect(thrown.code).toBe('client_not_configured');
    // The message names the key to set; a refusal that does not is a dead end.
    expect(thrown.message).toContain('LINEAR_CLIENT_ID');
  });

  it('refuses a dcr entry until registration has happened', () => {
    let thrown;
    try {
      resolvedClientId(entry({ client: 'dcr' }), {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe('client_registration_required');
  });
});

describe('hosted-mcp intake: discovery', () => {
  const discoveryUrl = 'https://mcp.linear.app/.well-known/oauth-authorization-server';

  it('reads the two endpoints it needs, from the well-known document', async () => {
    const seen = [];
    const server = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async (url) => { seen.push(url); return jsonResponse(AS_METADATA); },
    );
    expect(server.authorization_endpoint).toBe(AS_METADATA.authorization_endpoint);
    expect(server.token_endpoint).toBe(AS_METADATA.token_endpoint);
    expect(seen).toEqual([discoveryUrl]);
  });

  it('refuses an incomplete document rather than guessing an endpoint', async () => {
    let thrown;
    try {
      await discoverAuthorizationServer(
        'https://mcp.linear.app',
        async () => jsonResponse({ authorization_endpoint: AS_METADATA.authorization_endpoint }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe('issuer_metadata_incomplete');
  });

  it('names an unreachable issuer as unreachable, whether by status or by transport', async () => {
    const byStatus = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async () => jsonResponse({}, 500),
    ).catch((error) => error);
    const byTransport = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async () => { throw new Error('ECONNREFUSED'); },
    ).catch((error) => error);
    expect(byStatus.code).toBe('issuer_unreachable');
    expect(byTransport.code).toBe('issuer_unreachable');
  });
});

describe('hosted-mcp intake: RFC 8707\'s resource, on every request', () => {
  it('carries it on the authorization request', () => {
    const url = new URL(buildAuthorizeUrl(entry(), AS_METADATA.authorization_endpoint, {
      clientId: 'cid', redirectUri: 'https://api.example.test/cb', state: 's', codeChallenge: 'c',
    }));
    expect(url.searchParams.get('resource')).toBe(RESOURCE);
  });

  it('carries it on the code exchange and on the refresh alike', () => {
    // The spec makes `resource` a MUST on the token request, refresh included,
    // so both bodies are built here and both are read here.
    const exchange = buildTokenExchangeBody(entry(), {
      clientId: 'cid', redirectUri: 'https://api.example.test/cb', code: 'c', codeVerifier: 'v',
    });
    const refresh = buildRefreshBody(entry(), { clientId: 'cid', refreshToken: 'r' });
    expect(exchange.get('resource')).toBe(RESOURCE);
    expect(refresh.get('resource')).toBe(RESOURCE);
  });

  it('takes the resource from the entry, not from a literal any of the three could share', () => {
    // Control: move the entry's resource and all three follow. Without this the
    // three assertions above pass on a hardcoded vendor URL.
    const other = entry({ resource: 'https://mcp.other.test/mcp' });
    const url = new URL(buildAuthorizeUrl(other, AS_METADATA.authorization_endpoint, {
      clientId: 'cid', redirectUri: 'https://api.example.test/cb', state: 's', codeChallenge: 'c',
    }));
    const exchange = buildTokenExchangeBody(other, {
      clientId: 'cid', redirectUri: 'https://api.example.test/cb', code: 'c', codeVerifier: 'v',
    });
    const refresh = buildRefreshBody(other, { clientId: 'cid', refreshToken: 'r' });
    expect(url.searchParams.get('resource')).toBe('https://mcp.other.test/mcp');
    expect(exchange.get('resource')).toBe('https://mcp.other.test/mcp');
    expect(refresh.get('resource')).toBe('https://mcp.other.test/mcp');
  });
});

describe('hosted-mcp intake: the authorization request and PKCE', () => {
  it('asks for a code with S256, and names the callback the entry registered', () => {
    const url = new URL(buildAuthorizeUrl(entry(), AS_METADATA.authorization_endpoint, {
      clientId: 'cid',
      redirectUri: 'https://api.example.test/cb',
      state: 'the-state',
      codeChallenge: 'the-challenge',
    }));
    expect(url.origin + url.pathname).toBe('https://mcp.linear.app/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/cb');
    expect(url.searchParams.get('scope')).toBe('read openid');
  });

  it('derives the challenge from the verifier by sha256, in base64url', () => {
    const { verifier, challenge } = createPkcePair();
    // Recomputed here rather than through the service, so the arm fails if the
    // service ever hashes something other than the verifier it returns.
    const expected = require('crypto').createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats a state or a verifier', () => {
    expect(createStateNonce()).not.toBe(createStateNonce());
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
    expect(createStateNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps a pending window that expires', () => {
    // Read here because the callback's three state arms (not issued, used,
    // expired) are written against this bound rather than against a literal.
    expect(HOSTED_MCP_PENDING_TTL_MS).toBeGreaterThan(0);
  });
});
