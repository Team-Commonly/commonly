/**
 * Intake for a hosted-MCP Connection (TASK-172, build-order step 3;
 * `docs/plans/hosted-mcp-connection-scope.md` §4).
 *
 * The order is fixed by the ruling: a pre-registered client where the vendor
 * requires one, then a Client ID Metadata Document, then Dynamic Client
 * Registration only as a fallback. This module owns everything about that
 * order that is decidable without the vendor:
 *
 * - the client identity we present, and the credentials required by the
 *   instance's client kind (CIMD: `client_id` IS a URL we serve; a
 *   pre-registered client's id and secret come from instance environment, and
 *   the secret never enters the row);
 * - the authorization URL, including RFC 8707's `resource`, which the spec says
 *   MUST be on both the authorization request and the token request;
 * - PKCE `S256`, because a CIMD client is a public client with no secret.
 *
 * It deliberately does not talk to the vendor's token endpoint: the code
 * exchange is the callback's, and it needs the row's pending state.
 *
 * One document per INSTANCE per entry, not one per person: every authorization
 * server therefore sees one client id with exactly one redirect URI, and the
 * callback path names the entry — that is the redirect-per-AS defence against
 * mix-up (§4).
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { HostedMcpEntry } from './hostedMcpEntryService';
import { upstreamFetch } from './upstreamFetch';

/** Long enough for a person to finish a consent screen, short enough to be worthless afterwards. */
export const HOSTED_MCP_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * The instance's public API origin. `PUBLIC_API_URL` is the name the Slack
 * connect flow already reads, so a second OAuth client on this instance
 * inherits one origin rather than inventing another.
 */
export const hostedMcpApiBase = (): string =>
  String(process.env.PUBLIC_API_URL || process.env.BACKEND_URL || 'https://api.commonly.me')
    .replace(/\/$/, '');

/**
 * Both leaf URLs come from one place. A document that advertises a redirect URI
 * the start route does not send is a client the vendor accepts and then refuses
 * the code for, and two inline copies of the path is how the two drift.
 */
const CALLBACK_LEAF = 'callback';
const CLIENT_METADATA_LEAF = 'client-metadata';

const entryPathname = (entryId: string, leaf: string): string =>
  `/api/integrations/connect/hosted-mcp/${encodeURIComponent(entryId)}/${leaf}`;

const entryPath = (apiBase: string, entryId: string, leaf: string): string =>
  `${apiBase}${entryPathname(entryId, leaf)}`;

/** The one redirect URI this instance registers with this entry's authorization server. */
export const hostedMcpCallbackUrl = (entryId: string): string =>
  entryPath(hostedMcpApiBase(), entryId, CALLBACK_LEAF);

/** The URL that IS the client id under CIMD, and the document it serves. */
export const hostedMcpClientMetadataUrl = (entryId: string): string =>
  entryPath(hostedMcpApiBase(), entryId, CLIENT_METADATA_LEAF);

/**
 * The browser-bound half of the pending state (§10.7's cell; the Slack double
 * submit in `routes/installables.ts`).
 *
 * `state` is a bearer value the STARTER holds: it travels in the authorization
 * URL, so whoever the starter sends that URL to can finish the flow in their
 * own browser — and the code that comes back is the VICTIM'S. The consent
 * screen really does say "Commonly", which is what makes it work. PKCE does not
 * help: it binds the code to this instance, which is what the attacker wants.
 * The account-change rule does not fire either, because a first connect has no
 * stored subject to differ from.
 *
 * So the flow carries a SECOND secret, delivered to the starting browser as a
 * cookie scoped to this entry's callback and never readable by script. The two
 * are compared in constant time at the callback: the browser that finishes the
 * flow has to be the browser that started it.
 */
export const HOSTED_MCP_NONCE_COOKIE = 'commonly_hosted_mcp_nonce';

/**
 * The cookie's path is the callback's, built from the same leaf constant the
 * redirect URI comes from: a cookie scoped to a second spelling of the path
 * would be sent to no request that matters.
 */
export const hostedMcpNonceCookiePath = (entryId: string): string =>
  entryPathname(entryId, CALLBACK_LEAF);

/**
 * The Client ID Metadata Document. Its `client_id` is its own URL, which is
 * what lets an instance connect with no setup at the vendor — the thing a
 * pre-registered client cannot offer, since every instance would register its
 * own app with every vendor.
 */
export interface HostedMcpClientMetadataDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
  scope: string;
}

export const buildClientMetadataDocument = (
  entry: HostedMcpEntry,
  apiBase: string = hostedMcpApiBase(),
): HostedMcpClientMetadataDocument => {
  const clientId = entryPath(apiBase, entry.id, CLIENT_METADATA_LEAF);
  return {
    client_id: clientId,
    // Names the instance's product, not the person: the document is fetched by
    // the vendor before anyone has consented, and is the same for every member.
    client_name: `Commonly (${entry.title})`,
    // Exactly one, deliberately. A second URI here would re-open the mix-up the
    // entry-scoped path closes.
    redirect_uris: [entryPath(apiBase, entry.id, CALLBACK_LEAF)],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: entry.scopes.join(' '),
  };
};

export class HostedMcpClientError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'HostedMcpClientError';
  }
}

export interface HostedMcpClientConfiguration {
  clientId: string;
  /** Present only for an instance-configured pre-registered confidential client. */
  clientSecret?: string;
}

export type HostedMcpEndpointKind = 'token' | 'revocation';

export interface HostedMcpClientRequest {
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** The instance-level keys for one entry; the entry contains neither value. */
export const hostedMcpClientConfigKeys = (entryId: string) => {
  const prefix = entryId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return { clientId: `${prefix}_CLIENT_ID`, clientSecret: `${prefix}_CLIENT_SECRET` };
};

/**
 * Which client id we present for this entry, in the ruling's order.
 *
 * A `dcr` entry has no client id until registration, so this refuses rather
 * than inventing one: the caller registers first and passes the result. A
 * `pre-registered` entry's id arrives through the `api-keys` ExternalSecret as
 * the entry's own `<ENTRY>_CLIENT_ID`; an unset one is a configuration error at
 * the authorization boundary, which is where it should be loud.
 */
export const resolvedClientId = (
  entry: HostedMcpEntry,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (entry.client === 'cimd') return hostedMcpClientMetadataUrl(entry.id);
  if (entry.client === 'dcr') {
    throw new HostedMcpClientError(
      'client_registration_required',
      `entry ${entry.id} uses dynamic registration; register before authorizing`,
    );
  }
  const key = hostedMcpClientConfigKeys(entry.id).clientId;
  const value = env[key];
  if (!value?.trim()) {
    throw new HostedMcpClientError(
      'client_not_configured',
      `${key} is not configured for entry ${entry.id}`,
    );
  }
  return value;
};

/** A client secret exists only for the pre-registered confidential-client kind. */
export const resolvedClientSecret = (
  entry: HostedMcpEntry,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  if (entry.client !== 'pre-registered') return undefined;
  const key = hostedMcpClientConfigKeys(entry.id).clientSecret;
  const value = env[key];
  if (!value?.trim()) {
    throw new HostedMcpClientError(
      'client_not_configured',
      `${key} is not configured for entry ${entry.id}`,
    );
  }
  return value;
};

/** Resolve all instance-held client material before offering or using the entry. */
export const resolvedHostedMcpClient = (
  entry: HostedMcpEntry,
  env: NodeJS.ProcessEnv = process.env,
): HostedMcpClientConfiguration => {
  const clientId = resolvedClientId(entry, env);
  const clientSecret = resolvedClientSecret(entry, env);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
};

export const isHostedMcpClientConfigured = (
  entry: HostedMcpEntry,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  try {
    resolvedHostedMcpClient(entry, env);
    return true;
  } catch {
    return false;
  }
};

/** The authorization server's metadata, of which intake needs two fields. */
export interface HostedMcpAuthorizationServer {
  /**
   * RFC 8414 §2 makes this REQUIRED, so it is optional here only to be checked:
   * a document that omits it cannot be matched against the issuer we asked, and
   * `discoverAuthorizationServer` refuses it rather than reading endpoints from a
   * document whose identity is unstated.
   */
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint_auth_methods_supported?: string[];
}

/**
 * The metadata URL for an issuer, per RFC 8414 §3.1: the well-known segment is
 * inserted between the host and the issuer's path, so an issuer mounted under a
 * path resolves at `/.well-known/oauth-authorization-server/tenant` and NOT at
 * `/tenant/.well-known/oauth-authorization-server`. A bare origin — the shape
 * every vendor in the first wave uses — has no path to insert before, which is
 * why the two agree there and why the bare case alone cannot witness the rule.
 *
 * A malformed issuer, or one carrying a query or fragment (which §2 forbids),
 * is refused rather than repaired: interpolating it builds a URL that reaches a
 * host the entry never named and then reports the result as that entry's
 * metadata.
 */
const authorizationServerMetadataUrl = (issuer: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new HostedMcpClientError('issuer_unreachable', `issuer is not a URL: ${issuer}`);
  }
  if (parsed.search || parsed.hash) {
    throw new HostedMcpClientError(
      'issuer_unreachable',
      `issuer carries a query or fragment, which RFC 8414 forbids: ${issuer}`,
    );
  }
  const path = parsed.pathname.replace(/\/$/, '');
  return `${parsed.origin}/.well-known/oauth-authorization-server${path}`;
};

/**
 * Discovery is a GET of the issuer's well-known document. `fetchImpl` is a
 * parameter because intake is measured against a stub authorization server: the
 * ruling pins that every step except the live lines is testable without the
 * vendor.
 */
export const discoverAuthorizationServer = async (
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostedMcpAuthorizationServer> => {
  const url = authorizationServerMetadataUrl(issuer);
  let response: Response;
  try {
    response = await upstreamFetch(url, { headers: { Accept: 'application/json' } }, fetchImpl);
  } catch (error) {
    throw new HostedMcpClientError(
      'issuer_unreachable',
      `authorization server metadata could not be fetched: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new HostedMcpClientError(
      'issuer_unreachable',
      `authorization server metadata returned ${response.status}`,
    );
  }
  const body = (await response.json()) as Partial<HostedMcpAuthorizationServer>;
  // §3.3: the document's `issuer` must be IDENTICAL to the issuer the URL was
  // built from, and identity is checked before any endpoint is read out of it.
  // This is the mix-up defence, and what it defends is the strongest thing in
  // this file: `authorization_endpoint` is where the browser is sent next, so a
  // document fetched for this URL but written for another issuer would hand the
  // person's consent to whoever wrote it. Exact comparison, with no
  // trailing-slash allowance — the entry's issuer is ours to write, so a document
  // that does not match it character for character is not the identity we asked
  // for.
  if (!body.issuer) {
    throw new HostedMcpClientError(
      'issuer_metadata_incomplete',
      'authorization server metadata names no issuer',
    );
  }
  if (body.issuer !== issuer) {
    throw new HostedMcpClientError(
      'issuer_mismatch',
      `authorization server metadata is for a different issuer: ${body.issuer}`,
    );
  }
  if (!body.authorization_endpoint || !body.token_endpoint) {
    // Named rather than defaulted: guessing an endpoint from the issuer is how a
    // flow sends a code to a host the metadata never named.
    throw new HostedMcpClientError(
      'issuer_metadata_incomplete',
      'authorization server metadata names no authorization_endpoint or token_endpoint',
    );
  }
  return body as HostedMcpAuthorizationServer;
};

/**
 * The authorization request. `resource` is RFC 8707's, and the spec makes it a
 * MUST on this request and on the token request alike, so the two are built by
 * one function pair rather than by two call sites that could drift.
 */
export const buildAuthorizeUrl = (
  entry: HostedMcpEntry,
  authorizationEndpoint: string,
  params: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string => {
  const query = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: entry.scopes.join(' '),
    resource: entry.resource,
  });
  // Vendor-specific values are part of the reviewed entry, never caller input.
  // Refuse collisions so they cannot replace the client, state, PKCE, scope or
  // resource values this request is required to carry.
  const requiredParams = new Set([
    'client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge',
    'code_challenge_method', 'scope', 'resource',
  ]);
  Object.entries(entry.authorizationParams ?? {}).forEach(([key, value]) => {
    if (requiredParams.has(key)) {
      throw new HostedMcpClientError(
        'authorization_parameter_conflict',
        `entry ${entry.id} authorization parameter conflicts with ${key}`,
      );
    }
    query.set(key, value);
  });
  // `?` only when the endpoint carries no query yet: an authorization endpoint
  // that already has one is joined with `&`, and one that ends in `?` or `&`
  // (a vendor inviting parameters) takes no separator at all — appending `?`
  // blindly turns both into a second, empty parameter and moves `client_id` out
  // of the query the vendor parses.
  const separator = /[?&]$/.test(authorizationEndpoint)
    ? ''
    : (authorizationEndpoint.includes('?') ? '&' : '?');
  return `${authorizationEndpoint}${separator}${query.toString()}`;
};

interface ClientEndpointAuthentication {
  headers: Record<string, string>;
  body: Record<string, string>;
}

const formEncode = (value: string): string => (
  new URLSearchParams([['value', value]]).toString().slice('value='.length)
);

const endpointAuthentication = (
  entry: HostedMcpEntry,
  metadata: Partial<HostedMcpAuthorizationServer>,
  client: HostedMcpClientConfiguration,
  endpoint: HostedMcpEndpointKind,
): ClientEndpointAuthentication => {
  if (entry.client !== 'pre-registered') {
    return { headers: {}, body: { client_id: client.clientId } };
  }
  if (!client.clientSecret) {
    throw new HostedMcpClientError(
      'client_not_configured',
      `${hostedMcpClientConfigKeys(entry.id).clientSecret} is not configured for entry ${entry.id}`,
    );
  }

  // RFC 8414 defaults an omitted endpoint method list to client_secret_basic.
  // An explicit empty/unsupported list is a refusal; do not silently fall back
  // to a different authentication method than this server advertised.
  const supported = endpoint === 'token'
    ? metadata.token_endpoint_auth_methods_supported
    : metadata.revocation_endpoint_auth_methods_supported;
  const methods = supported === undefined
    ? ['client_secret_basic']
    : (Array.isArray(supported) ? supported : []);
  const method = ['client_secret_basic', 'client_secret_post']
    .find((candidate) => methods.includes(candidate));
  if (!method) {
    throw new HostedMcpClientError(
      'client_auth_unsupported',
      `authorization server advertises no supported ${endpoint} client-secret method for ${entry.id}`,
    );
  }
  if (method === 'client_secret_post') {
    return {
      headers: {},
      body: { client_id: client.clientId, client_secret: client.clientSecret },
    };
  }
  const basic = `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`;
  return {
    headers: { Authorization: `Basic ${Buffer.from(basic).toString('base64')}` },
    body: {},
  };
};

/** Authorization-code exchange: PKCE and resource survive every client kind. */
export const buildTokenExchangeRequest = (
  entry: HostedMcpEntry,
  metadata: Partial<HostedMcpAuthorizationServer>,
  client: HostedMcpClientConfiguration,
  params: { redirectUri: string; code: string; codeVerifier: string },
): HostedMcpClientRequest => {
  const authentication = endpointAuthentication(entry, metadata, client, 'token');
  return {
    headers: authentication.headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
      code: params.code,
      code_verifier: params.codeVerifier,
      resource: entry.resource,
      ...authentication.body,
    }),
  };
};

/** Refresh uses the same client and endpoint-authentication rule as the exchange. */
export const buildRefreshRequest = (
  entry: HostedMcpEntry,
  metadata: Partial<HostedMcpAuthorizationServer>,
  client: HostedMcpClientConfiguration,
  params: { refreshToken: string },
): HostedMcpClientRequest => {
  const authentication = endpointAuthentication(entry, metadata, client, 'token');
  return {
    headers: authentication.headers,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      resource: entry.resource,
      ...authentication.body,
    }),
  };
};

/** RFC 7009 request: the same client must authenticate the revocation. */
export const buildRevocationRequest = (
  entry: HostedMcpEntry,
  metadata: Partial<HostedMcpAuthorizationServer>,
  client: HostedMcpClientConfiguration,
  params: { token: string; tokenTypeHint: 'refresh_token' | 'access_token' },
): HostedMcpClientRequest => {
  const authentication = endpointAuthentication(entry, metadata, client, 'revocation');
  return {
    headers: authentication.headers,
    body: new URLSearchParams({
      token: params.token,
      token_type_hint: params.tokenTypeHint,
      ...authentication.body,
    }),
  };
};

/**
 * The state nonce. Its single use is enforced by the row (`config.pendingAuth`),
 * not by this value: the callback claims the state by a conditional update, so
 * a replay finds nothing to claim.
 */
export const createStateNonce = (): string => randomBytes(24).toString('base64url');

/**
 * The browser nonce. Minted independently of the state and the same width, so
 * holding one of the two is no evidence of holding the other.
 */
export const createBrowserNonce = (): string => randomBytes(24).toString('base64url');

/**
 * Constant-time comparison, mirroring the Slack precedent (`matchesSlackNonce`,
 * `routes/installables.ts`): a stored value that is missing or not a string is a
 * mismatch rather than a crash, and nothing about the compare depends on where
 * the first difference is.
 */
export const browserNonceMatches = (stored: unknown, supplied: string): boolean => {
  if (typeof stored !== 'string' || !stored) return false;
  const expected = Buffer.from(stored);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/**
 * One cookie out of a request's `Cookie` header, or nothing. Hand-rolled for the
 * same reason the Slack flow hand-rolled one: this route is mounted without
 * `cookie-parser`, and a dependency added for three lines of parsing would be
 * parseable by the attacker's input either way.
 */
export const readCookie = (header: unknown, name: string): string | undefined => {
  const serialized = Array.isArray(header) ? header.join(';') : header;
  if (typeof serialized !== 'string' || !serialized) return undefined;
  const hit = serialized
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!hit) return undefined;
  try {
    return decodeURIComponent(hit.slice(name.length + 1));
  } catch {
    return undefined;
  }
};

/**
 * PKCE, and it is not optional here: a CIMD client is a public client that
 * holds no secret, so `S256` is the only thing binding the code to this
 * instance. 32 random bytes is the RFC 7636 minimum verifier (43 characters)
 * and leaves no padding for a hand-rolled encoder to get wrong.
 */
export const createPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};
