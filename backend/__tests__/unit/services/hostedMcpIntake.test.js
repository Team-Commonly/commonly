// TASK-172 slice 3: intake — the client identity, the authorization request and
// PKCE (docs/plans/hosted-mcp-connection-scope.md §4). Nothing here reaches a
// vendor: the authorization server is a stub the test passes in, which is the
// ruling's point that every step except the live lines is testable without one.
const {
  HOSTED_MCP_NONCE_COOKIE,
  HOSTED_MCP_PENDING_TTL_MS,
  HostedMcpClientError,
  browserNonceMatches,
  buildAuthorizeUrl,
  buildClientMetadataDocument,
  buildRefreshRequest,
  buildRevocationRequest,
  buildTokenExchangeRequest,
  createBrowserNonce,
  createPkcePair,
  createStateNonce,
  discoverAuthorizationServer,
  hostedMcpCallbackUrl,
  hostedMcpClientConfigKeys,
  hostedMcpNonceCookiePath,
  readCookie,
  resolvedClientId,
  resolvedHostedMcpClient,
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
  issuer: 'https://mcp.linear.app',
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

  it('names the instance keys and requires both values for a pre-registered client', () => {
    const staticEntry = entry({ id: 'google-calendar', client: 'pre-registered' });
    expect(hostedMcpClientConfigKeys(staticEntry.id)).toEqual({
      clientId: 'GOOGLE_CALENDAR_CLIENT_ID',
      clientSecret: 'GOOGLE_CALENDAR_CLIENT_SECRET',
    });
    expect(() => resolvedHostedMcpClient(staticEntry, {})).toThrow(expect.objectContaining({
      code: 'client_not_configured',
      message: expect.stringContaining('GOOGLE_CALENDAR_CLIENT_ID'),
    }));
    expect(() => resolvedHostedMcpClient(staticEntry, { GOOGLE_CALENDAR_CLIENT_ID: 'client-id' }))
      .toThrow(expect.objectContaining({
        code: 'client_not_configured',
        message: expect.stringContaining('GOOGLE_CALENDAR_CLIENT_SECRET'),
      }));
    expect(resolvedHostedMcpClient(staticEntry, {
      GOOGLE_CALENDAR_CLIENT_ID: 'client-id',
      GOOGLE_CALENDAR_CLIENT_SECRET: 'instance-secret',
    })).toEqual({ clientId: 'client-id', clientSecret: 'instance-secret' });
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
    // `issuer` is present ON PURPOSE. Without it this document is refused for
    // naming no issuer — the SAME code the missing endpoint gets — so deleting the
    // endpoint guard below changes no test, which is how it went unwitnessed. The
    // message is the only thing that tells the two defects apart, so both this arm
    // and the no-issuer arm pin theirs.
    let thrown;
    try {
      await discoverAuthorizationServer(
        'https://mcp.linear.app',
        async () => jsonResponse({
          issuer: 'https://mcp.linear.app',
          authorization_endpoint: AS_METADATA.authorization_endpoint,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe('issuer_metadata_incomplete');
    expect(thrown.message).toBe('authorization server metadata names no authorization_endpoint or token_endpoint');
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

  it('inserts the well-known segment between the host and an issuer\'s path (RFC 8414 §3.1)', async () => {
    // An issuer mounted under a path resolves at host/.well-known/<segment>/path.
    // The bare-origin arm above cannot witness this rule: both shapes agree when
    // there is no path.
    const seen = [];
    await discoverAuthorizationServer(
      'https://api.example.test/tenant/',
      // The document answers for the issuer it was asked about, trailing slash and
      // all: §3.3 compares the two strings exactly, which is also why this fixture
      // has to echo the requested issuer rather than the entry's.
      async (url) => { seen.push(url); return jsonResponse({ ...AS_METADATA, issuer: 'https://api.example.test/tenant/' }); },
    );
    expect(seen).toEqual(['https://api.example.test/.well-known/oauth-authorization-server/tenant']);
    // Control: the shape that appends instead of inserts is not what was sent.
    expect(seen[0]).not.toContain('/tenant/.well-known/');
  });

  it('tells a deadline apart from a refusal, and hands every fetch one', async () => {
    const seen = [];
    await discoverAuthorizationServer('https://mcp.linear.app', async (url, init) => {
      seen.push([url, init]);
      return jsonResponse(AS_METADATA);
    });
    expect(seen[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0][1].headers).toEqual({ Accept: 'application/json' });

    // A stalled authorization server arrives as the same named state as a
    // refused one, because the callback has one redirect for both.
    const byDeadline = await discoverAuthorizationServer('https://mcp.linear.app', async () => {
      throw Object.assign(new Error('the operation timed out'), { name: 'TimeoutError' });
    }).catch((error) => error);
    expect(byDeadline.code).toBe('issuer_unreachable');
  });

  it('refuses an issuer it cannot build a URL from, without reaching the network', async () => {
    let calls = 0;
    const stub = async () => { calls += 1; return jsonResponse(AS_METADATA); };
    const malformed = await discoverAuthorizationServer('mcp.linear.app', stub).catch((error) => error);
    expect(malformed.code).toBe('issuer_unreachable');
    // §2 forbids a query or fragment in an issuer identifier; interpolating one
    // resolves the document at a host or path the entry never named.
    const withQuery = await discoverAuthorizationServer('https://api.example.test/tenant?x=1', stub).catch((error) => error);
    expect(withQuery.code).toBe('issuer_unreachable');
    expect(calls).toBe(0);
    // Control: the same stub IS reached for a well-formed issuer, so `calls === 0`
    // is a refusal rather than a stub that never runs.
    await discoverAuthorizationServer('https://mcp.linear.app', stub);
    expect(calls).toBe(1);
  });
});

describe('hosted-mcp intake: the document\'s own issuer claim (RFC 8414 §3.3)', () => {
  it('refuses a document written for a different issuer, and accepts it for its own', async () => {
    // What this defends is the next line of the flow: `authorization_endpoint` is
    // where the person's browser is sent, so a document fetched for this URL but
    // written for another issuer hands the consent to whoever wrote it.
    const foreign = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async () => jsonResponse({ ...AS_METADATA, issuer: 'https://mcp.example.test' }),
    ).catch((error) => error);
    expect(foreign.code).toBe('issuer_mismatch');
    // The message names the DOCUMENT's issuer, not the one we asked about: the
    // reader is an operator whose next question is what the vendor actually said.
    expect(foreign.message).toContain('https://mcp.example.test');

    // Acceptance control, differing ONLY in the issuer: without it, a stub that
    // never answered would look identical to a refusal.
    const accepted = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async () => jsonResponse({ ...AS_METADATA, issuer: 'https://mcp.linear.app' }),
    );
    expect(accepted.authorization_endpoint).toBe(AS_METADATA.authorization_endpoint);
  });

  it('refuses a document that states no issuer at all', async () => {
    // §2 makes `issuer` REQUIRED; a document without one has no identity to match,
    // and it is incomplete rather than foreign.
    const noIssuer = {
      authorization_endpoint: AS_METADATA.authorization_endpoint,
      token_endpoint: AS_METADATA.token_endpoint,
    };
    const thrown = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async () => jsonResponse(noIssuer),
    ).catch((error) => error);
    expect(thrown.code).toBe('issuer_metadata_incomplete');
    expect(thrown.message).toBe('authorization server metadata names no issuer');
  });

  it('compares the two values as given, so a trailing slash is a different issuer', async () => {
    // §3.3 says the values must be IDENTICAL, and a trailing-slash allowance is how
    // an identity check quietly becomes a prefix check. Measured against the four
    // first-wave vendors: each echoes its issuer byte-for-byte, and every entry's
    // issuer is ours to write, so nothing needs the allowance.
    const thrown = await discoverAuthorizationServer(
      'https://mcp.linear.app',
      async () => jsonResponse({ ...AS_METADATA, issuer: 'https://mcp.linear.app/' }),
    ).catch((error) => error);
    expect(thrown.code).toBe('issuer_mismatch');
  });
});

describe('hosted-mcp intake: joining the authorization endpoint\'s own query', () => {
  const params = {
    clientId: 'cid', redirectUri: 'https://api.example.test/cb', state: 's', codeChallenge: 'c',
  };

  it('uses `?` for an endpoint with no query and `&` when it already carries one', () => {
    const bare = new URL(buildAuthorizeUrl(entry(), AS_METADATA.authorization_endpoint, params));
    expect(bare.searchParams.get('client_id')).toBe('cid');

    const withQuery = new URL(buildAuthorizeUrl(entry(), 'https://mcp.linear.app/authorize?tenant=t1', params));
    expect(withQuery.searchParams.get('tenant')).toBe('t1');
    expect(withQuery.searchParams.get('client_id')).toBe('cid');
    expect(withQuery.searchParams.get('resource')).toBe(RESOURCE);
  });

  it('adds no separator to an endpoint that already ends in one', () => {
    // A vendor that ends its endpoint in `?` or `&` is inviting parameters;
    // appending `?` blind gives `?` + `?client_id=` — an empty parameter, with
    // the real ones moving into a second query the vendor does not parse.
    const endsInQuestion = buildAuthorizeUrl(entry(), 'https://mcp.linear.app/authorize?', params);
    expect(endsInQuestion.startsWith('https://mcp.linear.app/authorize?client_id=')).toBe(true);

    const endsInAmpersand = buildAuthorizeUrl(entry(), 'https://mcp.linear.app/authorize?tenant=t1&', params);
    expect(endsInAmpersand).not.toContain('?&');
    expect(new URL(endsInAmpersand).searchParams.get('client_id')).toBe('cid');
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
    const exchange = buildTokenExchangeRequest(entry(), {}, { clientId: 'cid' }, {
      redirectUri: 'https://api.example.test/cb', code: 'c', codeVerifier: 'v',
    });
    const refresh = buildRefreshRequest(entry(), {}, { clientId: 'cid' }, { refreshToken: 'r' });
    expect(exchange.body.get('resource')).toBe(RESOURCE);
    expect(refresh.body.get('resource')).toBe(RESOURCE);
  });

  it('takes the resource from the entry, not from a literal any of the three could share', () => {
    // Control: move the entry's resource and all three follow. Without this the
    // three assertions above pass on a hardcoded vendor URL.
    const other = entry({ resource: 'https://mcp.other.test/mcp' });
    const url = new URL(buildAuthorizeUrl(other, AS_METADATA.authorization_endpoint, {
      clientId: 'cid', redirectUri: 'https://api.example.test/cb', state: 's', codeChallenge: 'c',
    }));
    const exchange = buildTokenExchangeRequest(other, {}, { clientId: 'cid' }, {
      redirectUri: 'https://api.example.test/cb', code: 'c', codeVerifier: 'v',
    });
    const refresh = buildRefreshRequest(other, {}, { clientId: 'cid' }, { refreshToken: 'r' });
    expect(url.searchParams.get('resource')).toBe('https://mcp.other.test/mcp');
    expect(exchange.body.get('resource')).toBe('https://mcp.other.test/mcp');
    expect(refresh.body.get('resource')).toBe('https://mcp.other.test/mcp');
  });
});

describe('hosted-mcp intake: pre-registered client authentication', () => {
  it('a pre-registered client authenticates at token and revocation endpoints, and still sends PKCE', () => {
    const staticEntry = entry({ id: 'google-calendar', client: 'pre-registered' });
    const client = { clientId: 'registered-client', clientSecret: 'registered-secret' };
    const metadata = {
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
    };
    const expectedAuthorization = `Basic ${Buffer.from('registered-client:registered-secret').toString('base64')}`;

    const token = buildTokenExchangeRequest(staticEntry, metadata, client, {
      redirectUri: 'https://api.example.test/callback',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
    });
    expect(token.headers.Authorization).toBe(expectedAuthorization);
    expect(token.body.get('code_verifier')).toBe('pkce-verifier');
    expect(token.body.get('resource')).toBe(RESOURCE);
    expect(token.body.get('client_id')).toBeNull();
    expect(token.body.get('client_secret')).toBeNull();

    const refresh = buildRefreshRequest(staticEntry, metadata, client, { refreshToken: 'refresh-token' });
    expect(refresh.headers.Authorization).toBe(expectedAuthorization);
    expect(refresh.body.get('refresh_token')).toBe('refresh-token');

    const revoke = buildRevocationRequest(staticEntry, metadata, client, {
      token: 'held-refresh-token', tokenTypeHint: 'refresh_token',
    });
    expect(revoke.headers.Authorization).toBe(expectedAuthorization);
    expect(revoke.body.get('token')).toBe('held-refresh-token');
    expect(revoke.body.get('token_type_hint')).toBe('refresh_token');
    expect(revoke.body.get('client_secret')).toBeNull();
  });

  it('uses the authorization server default when the endpoint auth method list is omitted', () => {
    const staticEntry = entry({ id: 'google-calendar', client: 'pre-registered' });
    const request = buildRefreshRequest(staticEntry, {}, {
      clientId: 'registered-client', clientSecret: 'registered-secret',
    }, { refreshToken: 'refresh-token' });
    expect(request.headers.Authorization).toBe(
      `Basic ${Buffer.from('registered-client:registered-secret').toString('base64')}`,
    );
  });

  it('uses client_secret_post when both endpoints advertise it', () => {
    const staticEntry = entry({ id: 'google-calendar', client: 'pre-registered' });
    const metadata = {
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_post'],
    };
    const client = { clientId: 'registered-client', clientSecret: 'registered-secret' };
    const exchange = buildTokenExchangeRequest(staticEntry, metadata, client, {
      redirectUri: 'https://api.example.test/callback', code: 'authorization-code', codeVerifier: 'pkce',
    });
    const refresh = buildRefreshRequest(staticEntry, metadata, client, { refreshToken: 'refresh-token' });
    const revoke = buildRevocationRequest(staticEntry, metadata, client, {
      token: 'held-refresh-token', tokenTypeHint: 'refresh_token',
    });

    for (const request of [exchange, refresh, revoke]) {
      expect(request.headers.Authorization).toBeUndefined();
      expect(request.body.get('client_id')).toBe(client.clientId);
      expect(request.body.get('client_secret')).toBe(client.clientSecret);
    }
    expect(exchange.body.get('code_verifier')).toBe('pkce');
    expect(revoke.body.get('token')).toBe('held-refresh-token');
  });

  it.each([
    [
      'token endpoint advertises private_key_jwt only',
      { token_endpoint_auth_methods_supported: ['private_key_jwt'] },
      (staticEntry, metadata, client) => buildTokenExchangeRequest(staticEntry, metadata, client, {
        redirectUri: 'https://api.example.test/callback', code: 'authorization-code', codeVerifier: 'pkce',
      }),
    ],
    [
      'token endpoint advertises an empty list',
      { token_endpoint_auth_methods_supported: [] },
      (staticEntry, metadata, client) => buildTokenExchangeRequest(staticEntry, metadata, client, {
        redirectUri: 'https://api.example.test/callback', code: 'authorization-code', codeVerifier: 'pkce',
      }),
    ],
    [
      'revocation endpoint advertises private_key_jwt only',
      { revocation_endpoint_auth_methods_supported: ['private_key_jwt'] },
      (staticEntry, metadata, client) => buildRevocationRequest(staticEntry, metadata, client, {
        token: 'held-refresh-token', tokenTypeHint: 'refresh_token',
      }),
    ],
    [
      'revocation endpoint advertises an empty list',
      { revocation_endpoint_auth_methods_supported: [] },
      (staticEntry, metadata, client) => buildRevocationRequest(staticEntry, metadata, client, {
        token: 'held-refresh-token', tokenTypeHint: 'refresh_token',
      }),
    ],
  ])('refuses pre-registered client auth when %s', (_case, metadata, build) => {
    const staticEntry = entry({ id: 'google-calendar', client: 'pre-registered' });
    const client = { clientId: 'registered-client', clientSecret: 'registered-secret' };
    let thrown;
    try {
      build(staticEntry, metadata, client);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostedMcpClientError);
    expect(thrown?.code).toBe('client_auth_unsupported');
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

describe('hosted-mcp intake: the browser-bound half of the pending state', () => {
  it('scopes the nonce cookie to the callback path the redirect URI names', () => {
    // Both come from ONE leaf constant. A cookie scoped to a second spelling of
    // the path is never received by the callback it guards, and a check that
    // never receives its cookie refuses every legitimate connect.
    expect(hostedMcpNonceCookiePath('linear')).toBe(
      new URL(hostedMcpCallbackUrl('linear')).pathname,
    );
    expect(hostedMcpNonceCookiePath('linear')).toBe(
      '/api/integrations/connect/hosted-mcp/linear/callback',
    );
  });

  it('mints the browser nonce independently of the state', () => {
    const nonce = createBrowserNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createBrowserNonce()).not.toBe(nonce);
    // Holding the state is no evidence of holding the nonce, which is the whole
    // reason there are two secrets rather than one.
    expect(createStateNonce()).not.toBe(nonce);
  });

  it('compares a stored nonce to a supplied one, and reads every absence as a mismatch', () => {
    const nonce = createBrowserNonce();
    expect(browserNonceMatches(nonce, nonce)).toBe(true);
    expect(browserNonceMatches(nonce, createBrowserNonce())).toBe(false);
    // Length first: an extension or a prefix is a mismatch, and `timingSafeEqual`
    // throws on unequal lengths rather than answering false.
    expect(browserNonceMatches(nonce, `${nonce}x`)).toBe(false);
    expect(browserNonceMatches(nonce, nonce.slice(0, -1))).toBe(false);
    // What a strict subdocument without the field hands back — the shape that
    // must NOT read as "the guard is armed".
    expect(browserNonceMatches(undefined, nonce)).toBe(false);
    expect(browserNonceMatches(null, nonce)).toBe(false);
    expect(browserNonceMatches('', '')).toBe(false);
    expect(browserNonceMatches({}, nonce)).toBe(false);
  });

  it('reads one cookie out of a header, and nothing out of a malformed one', () => {
    const header = 'a=1; commonly_hosted_mcp_nonce=browser-1; b=2';
    expect(readCookie(header, HOSTED_MCP_NONCE_COOKIE)).toBe('browser-1');
    expect(readCookie('commonly_hosted_mcp_nonce=browser-1', HOSTED_MCP_NONCE_COOKIE)).toBe('browser-1');
    expect(readCookie(['a=1', 'commonly_hosted_mcp_nonce=browser-1'], HOSTED_MCP_NONCE_COOKIE)).toBe('browser-1');
    expect(readCookie('a=1; b=2', HOSTED_MCP_NONCE_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, HOSTED_MCP_NONCE_COOKIE)).toBeUndefined();
    // A name that only starts with ours is a different cookie.
    expect(readCookie('commonly_hosted_mcp_nonce_extra=x', HOSTED_MCP_NONCE_COOKIE)).toBeUndefined();
    // A percent-decode failure is a missing cookie, not a throw inside a public
    // route: this parse runs before anything else in the callback.
    expect(readCookie('commonly_hosted_mcp_nonce=%E0%A4%A', HOSTED_MCP_NONCE_COOKIE)).toBeUndefined();
  });
});
