/** Instance-scoped Dynamic Client Registration for hosted MCP public clients. */
import HostedMcpDcrRegistration from '../models/HostedMcpDcrRegistration';
import type { HostedMcpEntry } from './hostedMcpEntryService';
import {
  HostedMcpClientError,
  type HostedMcpAuthorizationServer,
  type HostedMcpClientConfiguration,
} from './hostedMcpIntakeService';
import { upstreamFetch } from './upstreamFetch';

const currentFilter = (entry: HostedMcpEntry) => ({
  entryId: entry.id,
  issuer: entry.issuer,
  current: true,
});

const asClient = (clientId: string): HostedMcpClientConfiguration => ({ clientId });

/**
 * A registration has one callback. Changing the instance host retires the old
 * client for new starts; rows already minted by it continue to use it.
 */
export const ensureDcrClient = async (
  entry: HostedMcpEntry,
  metadata: HostedMcpAuthorizationServer,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostedMcpClientConfiguration> => {
  if (entry.client !== 'dcr') {
    throw new HostedMcpClientError('client_registration_unsupported', 'entry does not use DCR');
  }
  // A first start can arrive before Mongoose's background index build finishes.
  // The upsert is safe only once the unique current-registration index exists.
  await HostedMcpDcrRegistration.init();
  const existing = await HostedMcpDcrRegistration.findOne(currentFilter(entry));
  if (existing?.redirectUri === redirectUri && !existing.refusedAt) return asClient(existing.clientId);
  if (existing) {
    await HostedMcpDcrRegistration.updateOne(
      { _id: existing._id, current: true },
      { $set: { current: false, retiredAt: new Date() } },
    );
  }

  // RFC 8414 defaults an omitted auth-method list to client_secret_basic.
  // These entries use public clients only; never POST hoping the AS accepts one.
  if (!Array.isArray(metadata.token_endpoint_auth_methods_supported)
    || !metadata.token_endpoint_auth_methods_supported.includes('none')
    || !metadata.registration_endpoint) {
    throw new HostedMcpClientError(
      'client_registration_unsupported',
      `authorization server does not advertise public-client registration for ${entry.id}`,
    );
  }
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
      token_endpoint_auth_method: 'none',
      scope: entry.scopes.join(' '),
    }),
  }, fetchImpl);
  if (!response.ok) {
    throw new HostedMcpClientError('client_registration_refused', `registration refused (${response.status})`);
  }
  const issued = await response.json().catch(() => null) as {
    client_id?: unknown;
    client_secret?: unknown;
    token_endpoint_auth_method?: unknown;
    redirect_uris?: unknown;
  } | null;
  if (!issued || typeof issued.client_id !== 'string' || !issued.client_id
    || issued.client_secret !== undefined
    || issued.token_endpoint_auth_method !== 'none'
    || !Array.isArray(issued.redirect_uris)
    || issued.redirect_uris.length !== 1
    || issued.redirect_uris[0] !== redirectUri) {
    throw new HostedMcpClientError(
      'client_registration_unsupported',
      'registration answer did not confirm the public client and sole callback',
    );
  }

  // Two first starts may both POST. The unique current index admits only one
  // registration; both starts then authorize with the stored winner's id.
  try {
    const stored = await HostedMcpDcrRegistration.findOneAndUpdate(
      currentFilter(entry),
      { $setOnInsert: {
        entryId: entry.id,
        issuer: entry.issuer,
        clientId: issued.client_id,
        redirectUri,
        current: true,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (!stored || stored.redirectUri !== redirectUri || stored.refusedAt) {
      throw new HostedMcpClientError('client_registration_refused', 'current registration changed during start');
    }
    return asClient(stored.clientId);
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    const winner = await HostedMcpDcrRegistration.findOne(currentFilter(entry));
    if (winner?.redirectUri === redirectUri && !winner.refusedAt) return asClient(winner.clientId);
    throw new HostedMcpClientError('client_registration_refused', 'concurrent registration changed');
  }
};

/** A row may use a retired registration, but never one the vendor refused. */
export const dcrClientForRow = async (
  entry: HostedMcpEntry,
  recordedClientId: string | undefined,
): Promise<HostedMcpClientConfiguration | null> => {
  if (entry.client !== 'dcr' || !recordedClientId) return null;
  const registration = await HostedMcpDcrRegistration.findOne({
    entryId: entry.id,
    issuer: entry.issuer,
    clientId: recordedClientId,
    refusedAt: null,
  });
  return registration ? asClient(registration.clientId) : null;
};

/** Invalid client on token/revoke poisons this registration, not every row. */
export const refuseDcrClient = async (entry: HostedMcpEntry, clientId: string): Promise<void> => {
  if (entry.client !== 'dcr') return;
  const now = new Date();
  await HostedMcpDcrRegistration.updateOne(
    { entryId: entry.id, issuer: entry.issuer, clientId, refusedAt: null },
    { $set: { refusedAt: now, retiredAt: now, current: false } },
  );
};
