/**
 * Intake for a hosted-MCP Connection (TASK-172, build-order step 3;
 * `docs/plans/hosted-mcp-connection-scope.md` §4).
 *
 * The order is fixed by the ruling: a pre-registered client where the vendor
 * requires one, then a Client ID Metadata Document, then Dynamic Client
 * Registration only as a fallback. This module owns everything about that
 * order that is decidable without the vendor:
 *
 * - the client identity we present, and the one public document that states it
 *   (CIMD: `client_id` IS a URL we serve, so nothing is registered and no
 *   client secret is stored anywhere);
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
import { createHash, randomBytes } from 'crypto';
import type { HostedMcpEntry } from './hostedMcpEntryService';

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

const entryPath = (apiBase: string, entryId: string, leaf: string): string =>
  `${apiBase}/api/integrations/connect/hosted-mcp/${encodeURIComponent(entryId)}/${leaf}`;

/** The one redirect URI this instance registers with this entry's authorization server. */
export const hostedMcpCallbackUrl = (entryId: string): string =>
  entryPath(hostedMcpApiBase(), entryId, CALLBACK_LEAF);

/** The URL that IS the client id under CIMD, and the document it serves. */
export const hostedMcpClientMetadataUrl = (entryId: string): string =>
  entryPath(hostedMcpApiBase(), entryId, CLIENT_METADATA_LEAF);

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
  const key = `${entry.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_ID`;
  const value = env[key];
  if (!value) {
    throw new HostedMcpClientError(
      'client_not_configured',
      `${key} is not configured for entry ${entry.id}`,
    );
  }
  return value;
};

/** The authorization server's metadata, of which intake needs two fields. */
export interface HostedMcpAuthorizationServer {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

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
  const url = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
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
  return `${authorizationEndpoint}?${query.toString()}`;
};

/** The token request's body, carrying the same `resource` the authorization request did. */
export const buildTokenExchangeBody = (
  entry: HostedMcpEntry,
  params: { clientId: string; redirectUri: string; code: string; codeVerifier: string },
): URLSearchParams => new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: params.clientId,
  redirect_uri: params.redirectUri,
  code: params.code,
  code_verifier: params.codeVerifier,
  resource: entry.resource,
});

/** The refresh body, same `resource`: the spec requires it on the token request, refresh included. */
export const buildRefreshBody = (
  entry: HostedMcpEntry,
  params: { clientId: string; refreshToken: string },
): URLSearchParams => new URLSearchParams({
  grant_type: 'refresh_token',
  client_id: params.clientId,
  refresh_token: params.refreshToken,
  resource: entry.resource,
});

/**
 * The state nonce. Its single use is enforced by the row (`config.pendingAuth`),
 * not by this value: the callback claims the state by a conditional update, so
 * a replay finds nothing to claim.
 */
export const createStateNonce = (): string => randomBytes(24).toString('base64url');

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
