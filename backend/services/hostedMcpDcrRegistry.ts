/**
 * Instance-scoped Dynamic Client Registration for hosted MCP clients.
 *
 * A vendor that offers public-client registration (`none` in its token
 * endpoint auth methods) gets a public client, as before. One that offers only
 * client_secret_basic or client_secret_post gets a confidential client
 * (TASK-248, Wren's scope 2026-10-19): gitlab.com and api.supabase.com list
 * only those two, so neither could connect. The issued secret is kept
 * encrypted in the connector-secret store, owned by the registration row (the
 * orphan sweep knows that owner), and authenticates the token, refresh and
 * revocation calls; PKCE S256 is still sent. No registration_access_token is
 * stored. A secret the vendor says will lapse is replaced by registering again
 * before it does.
 *
 * A client the vendor deleted fails on the vendor's own authorize page, which
 * never comes back here (F14). See `retireDcrClientIfUnknown` for how a
 * member's retry finds it, and scripts/retire-hosted-mcp-dcr-client.ts for an
 * admin's hand.
 */
import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import HostedMcpDcrRegistration, { IHostedMcpDcrRegistration } from '../models/HostedMcpDcrRegistration';
import type { HostedMcpOAuthEntry } from './hostedMcpEntryService';
import {
  buildTokenExchangeRequest,
  CONFIDENTIAL_CLIENT_METHODS,
  createPkcePair,
  HostedMcpClientError,
  type HostedMcpAuthorizationServer,
  type HostedMcpClientConfiguration,
} from './hostedMcpIntakeService';
import { upstreamFetch } from './upstreamFetch';
import { hostedVendorFetch } from './hostedVendorFetch';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const connectorSecrets = require('./connectorSecrets');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HOSTED_MCP_DCR_CLIENT_SECRET } = require('./connectorSecretKinds');

type ConfidentialMethod = typeof CONFIDENTIAL_CLIENT_METHODS[number];
type RegistrationMethod = 'none' | ConfidentialMethod;

/**
 * A secret that lapses within this margin is treated as lapsed, so a start
 * never hands the vendor a client about to stop working mid-flow.
 */
export const CLIENT_SECRET_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;

const currentFilter = (entry: HostedMcpOAuthEntry) => ({
  entryId: entry.id,
  issuer: entry.issuer,
  current: true,
});

type RegistrationRow = Pick<IHostedMcpDcrRegistration,
  'clientId' | 'tokenEndpointAuthMethod' | 'clientSecretRef' | 'clientSecretExpiresAt'>;

const secretLapsing = (row: RegistrationRow, now: Date): boolean => Boolean(
  row.clientSecretExpiresAt
  && new Date(row.clientSecretExpiresAt).getTime() - now.getTime() <= CLIENT_SECRET_RENEW_MARGIN_MS,
);

/**
 * The client a stored registration describes, with its secret decrypted for a
 * confidential one. Null when a confidential client's secret can't be read
 * (deleted, or its key left the ring): that registration can't authenticate.
 */
const clientFromRow = async (row: RegistrationRow): Promise<HostedMcpClientConfiguration | null> => {
  const method = (row.tokenEndpointAuthMethod || 'none') as RegistrationMethod;
  if (method === 'none') return { clientId: row.clientId };
  if (!row.clientSecretRef) return null;
  try {
    const clientSecret = await connectorSecrets.get(row.clientSecretRef);
    return clientSecret ? { clientId: row.clientId, clientSecret, tokenEndpointAuthMethod: method } : null;
  } catch {
    return null;
  }
};

/** Which method to register with, or a refusal before any POST. */
const registrationMethod = (entry: HostedMcpOAuthEntry, metadata: HostedMcpAuthorizationServer): RegistrationMethod => {
  const supported = metadata.token_endpoint_auth_methods_supported;
  // RFC 8414 defaults an omitted list to client_secret_basic, but this registry
  // registers only a method the vendor names: never POST hoping it accepts one.
  if (Array.isArray(supported)) {
    if (supported.includes('none')) return 'none';
    // Basic, then post: the order the token calls choose by (hostedMcpIntakeService).
    const confidential = CONFIDENTIAL_CLIENT_METHODS.find((method) => supported.includes(method));
    if (confidential) return confidential;
  }
  throw new HostedMcpClientError(
    'client_registration_unsupported',
    `authorization server advertises no client registration this instance supports for ${entry.id}`,
  );
};

/**
 * A registration has one callback. Changing the instance host retires the old
 * client for new starts; rows already minted by it continue to use it.
 */
export const ensureDcrClient = async (
  entry: HostedMcpOAuthEntry,
  metadata: HostedMcpAuthorizationServer,
  redirectUri: string,
  fetchImpl: typeof fetch = hostedVendorFetch,
  now: Date = new Date(),
): Promise<HostedMcpClientConfiguration> => {
  if (entry.client !== 'dcr') {
    throw new HostedMcpClientError('client_registration_unsupported', 'entry does not use DCR');
  }
  // A first start can arrive before Mongoose's background index build finishes.
  // The upsert is safe only once the unique current-registration index exists.
  await HostedMcpDcrRegistration.init();
  const existing = await HostedMcpDcrRegistration.findOne(currentFilter(entry));
  if (existing?.redirectUri === redirectUri && !existing.refusedAt && !secretLapsing(existing, now)) {
    const reused = await clientFromRow(existing);
    if (reused) return reused;
  }
  if (existing) {
    await HostedMcpDcrRegistration.updateOne(
      { _id: existing._id, current: true },
      { $set: { current: false, retiredAt: now } },
    );
  }

  if (!metadata.registration_endpoint) {
    throw new HostedMcpClientError(
      'client_registration_unsupported',
      `authorization server advertises no registration endpoint for ${entry.id}`,
    );
  }
  const method = registrationMethod(entry, metadata);
  let registrationUrl: URL;
  try {
    registrationUrl = new URL(metadata.registration_endpoint);
  } catch {
    throw new HostedMcpClientError('client_registration_unsupported', 'registration endpoint is not a URL');
  }
  if (registrationUrl.protocol !== 'https:') {
    throw new HostedMcpClientError('client_registration_unsupported', 'registration endpoint is not HTTPS');
  }

  const response = await upstreamFetch(registrationUrl.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: `Commonly (${entry.title})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: entry.scopes.join(' '),
    }),
  }, fetchImpl);
  if (!response.ok) {
    throw new HostedMcpClientError('client_registration_refused', `registration refused (${response.status})`);
  }
  const issued = await response.json().catch(() => null) as {
    client_id?: unknown;
    client_secret?: unknown;
    client_secret_expires_at?: unknown;
    token_endpoint_auth_method?: unknown;
    redirect_uris?: unknown;
  } | null;
  // RFC 7591 §2: an omitted token_endpoint_auth_method means client_secret_basic.
  const issuedMethod = issued?.token_endpoint_auth_method === undefined
    ? 'client_secret_basic'
    : issued.token_endpoint_auth_method;
  const confirmsCallback = Array.isArray(issued?.redirect_uris)
    && issued.redirect_uris.length === 1
    && issued.redirect_uris[0] === redirectUri;
  if (!issued || typeof issued.client_id !== 'string' || !issued.client_id || !confirmsCallback) {
    throw new HostedMcpClientError(
      'client_registration_unsupported',
      'registration answer did not confirm the client and its sole callback',
    );
  }
  if (method === 'none') {
    if (issued.client_secret !== undefined || issued.token_endpoint_auth_method !== 'none') {
      throw new HostedMcpClientError(
        'client_registration_unsupported',
        'registration answer did not confirm the public client and sole callback',
      );
    }
  } else if (typeof issued.client_secret !== 'string' || !issued.client_secret || issuedMethod !== method) {
    throw new HostedMcpClientError(
      'client_registration_unsupported',
      'registration answer did not confirm the confidential client, its secret and its auth method',
    );
  }
  // RFC 7591 §3.2.1: 0 means the secret never lapses; any other value is seconds since the epoch.
  let clientSecretExpiresAt: Date | null = null;
  if (method !== 'none' && issued.client_secret_expires_at !== undefined && issued.client_secret_expires_at !== 0) {
    const seconds = Number(issued.client_secret_expires_at);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new HostedMcpClientError(
        'client_registration_unsupported',
        'registration answer carried an unreadable secret expiry',
      );
    }
    clientSecretExpiresAt = new Date(seconds * 1000);
    if (secretLapsing({ clientId: issued.client_id, clientSecretExpiresAt }, now)) {
      throw new HostedMcpClientError(
        'client_registration_refused',
        'registration answer carried a secret that lapses too soon',
      );
    }
  }

  // The secret is stored before the row so the row is never written without
  // it; it is owned by the row's id, chosen here. A start that loses the
  // insert race below deletes its own secret and uses the winner's client.
  const registrationId = new Types.ObjectId();
  const clientSecretRef = method === 'none'
    ? null
    : await connectorSecrets.put(String(registrationId), HOSTED_MCP_DCR_CLIENT_SECRET, issued.client_secret as string);
  const discardOwnSecret = async () => {
    if (clientSecretRef) await connectorSecrets.revoke(clientSecretRef).catch(() => {});
  };

  // Two first starts may both POST. The unique current index admits only one
  // registration; both starts then authorize with the stored winner's client.
  try {
    const stored = await HostedMcpDcrRegistration.findOneAndUpdate(
      currentFilter(entry),
      { $setOnInsert: {
        _id: registrationId,
        entryId: entry.id,
        issuer: entry.issuer,
        clientId: issued.client_id,
        redirectUri,
        tokenEndpointAuthMethod: method,
        clientSecretRef,
        clientSecretExpiresAt,
        current: true,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (!stored || stored.redirectUri !== redirectUri || stored.refusedAt) {
      await discardOwnSecret();
      throw new HostedMcpClientError('client_registration_refused', 'current registration changed during start');
    }
    if (String(stored._id) !== String(registrationId)) await discardOwnSecret();
    const client = await clientFromRow(stored);
    if (!client) {
      throw new HostedMcpClientError('client_registration_refused', 'current registration has no usable secret');
    }
    return client;
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    await discardOwnSecret();
    const winner = await HostedMcpDcrRegistration.findOne(currentFilter(entry));
    const client = winner?.redirectUri === redirectUri && !winner.refusedAt ? await clientFromRow(winner) : null;
    if (client) return client;
    throw new HostedMcpClientError('client_registration_refused', 'concurrent registration changed');
  }
};

/** A row may use a retired registration, but never one the vendor refused. */
export const dcrClientForRow = async (
  entry: HostedMcpOAuthEntry,
  recordedClientId: string | undefined,
): Promise<HostedMcpClientConfiguration | null> => {
  if (entry.client !== 'dcr' || !recordedClientId) return null;
  const registration = await HostedMcpDcrRegistration.findOne({
    entryId: entry.id,
    issuer: entry.issuer,
    clientId: recordedClientId,
    refusedAt: null,
  });
  return registration ? clientFromRow(registration) : null;
};

/** Invalid client on token/revoke poisons this registration, not every row. */
export const refuseDcrClient = async (entry: HostedMcpOAuthEntry, clientId: string): Promise<void> => {
  if (entry.client !== 'dcr') return;
  const now = new Date();
  const refused = await HostedMcpDcrRegistration.findOneAndUpdate(
    { entryId: entry.id, issuer: entry.issuer, clientId, refusedAt: null },
    { $set: { refusedAt: now, retiredAt: now, current: false } },
  );
  // A refused client's secret is useless; delete it now rather than at the sweep.
  if (refused?.clientSecretRef) await connectorSecrets.revoke(refused.clientSecretRef).catch(() => {});
};

/** The vendor is asked about one registration at most this often. */
export const DCR_ASK_INTERVAL_MS = 10 * 60 * 1000;

export type DcrClientAnswer = 'unknown_client' | 'known' | 'unclear';

/**
 * Whether the vendor still knows a client, asked at its token endpoint with a
 * made-up code. RFC 6749 §5.2: invalid_client is a client the server can't
 * authenticate, which for a public client means one it no longer has;
 * invalid_grant means it knew the client and refused only the code. Anything
 * else, a failure to answer included, is unclear and changes nothing.
 */
export const askVendorAboutDcrClient = async (
  entry: HostedMcpOAuthEntry,
  metadata: HostedMcpAuthorizationServer,
  client: HostedMcpClientConfiguration,
  redirectUri: string,
  fetchImpl: typeof fetch = hostedVendorFetch,
): Promise<DcrClientAnswer> => {
  const request = buildTokenExchangeRequest(entry, metadata, client, {
    redirectUri,
    code: randomBytes(24).toString('base64url'),
    codeVerifier: createPkcePair().verifier,
  });
  try {
    const response = await upstreamFetch(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...request.headers,
      },
      body: request.body,
    }, fetchImpl);
    if (response.ok) return 'unclear';
    const refusal = await response.json().catch(() => null) as { error?: unknown } | null;
    if (refusal?.error === 'invalid_client') return 'unknown_client';
    if (refusal?.error === 'invalid_grant') return 'known';
    return 'unclear';
  } catch {
    return 'unclear';
  }
};

/**
 * Stop giving an entry's current client to new starts, so the next one
 * registers a new client. Rows it minted keep using it until the vendor refuses
 * one of their own token calls (`refuseDcrClient`). With `clientId`, only while
 * that client is still the current one. True when a client was retired.
 */
export const retireCurrentDcrClient = async (
  entry: HostedMcpOAuthEntry,
  clientId?: string,
  now: Date = new Date(),
): Promise<boolean> => {
  if (entry.client !== 'dcr') return false;
  const write = await HostedMcpDcrRegistration.updateOne(
    clientId ? { ...currentFilter(entry), clientId } : currentFilter(entry),
    { $set: { current: false, retiredAt: now } },
  );
  return (write.modifiedCount ?? 0) > 0;
};

/**
 * Called when a member starts again while their last start never came back.
 * A client the vendor deleted fails on the vendor's own authorize page, so a
 * start that never returned is the one sign of it this side gets. When
 * `clientId` is still the entry's current client, the vendor is asked about it,
 * at most once per DCR_ASK_INTERVAL_MS. If the vendor no longer knows it, it is
 * retired, and this start registers a new one. A member who simply closed the
 * tab costs one ask. True when the client was retired; never throws.
 */
export const retireDcrClientIfUnknown = async (
  entry: HostedMcpOAuthEntry,
  metadata: HostedMcpAuthorizationServer,
  clientId: string,
  fetchImpl: typeof fetch = hostedVendorFetch,
  now: Date = new Date(),
): Promise<boolean> => {
  if (entry.client !== 'dcr' || !clientId) return false;
  try {
    const claimed = await HostedMcpDcrRegistration.findOneAndUpdate(
      {
        ...currentFilter(entry),
        clientId,
        refusedAt: null,
        $or: [{ askedAt: null }, { askedAt: { $lte: new Date(now.getTime() - DCR_ASK_INTERVAL_MS) } }],
      },
      { $set: { askedAt: now } },
      { new: true },
    );
    // ensureDcrClient replaces a client whose secret can't be read on its own.
    const client = claimed ? await clientFromRow(claimed) : null;
    if (!claimed || !client) return false;
    const answer = await askVendorAboutDcrClient(entry, metadata, client, claimed.redirectUri, fetchImpl);
    return answer === 'unknown_client' && retireCurrentDcrClient(entry, clientId, now);
  } catch {
    return false;
  }
};
