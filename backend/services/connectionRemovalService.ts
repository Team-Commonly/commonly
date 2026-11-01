/**
 * Removing a Connection, in the one order that holds (TASK-172 §9; the order
 * itself is §10.5 of `docs/plans/tools-catalogue-room-grants.md`):
 * grants, row, provider, mark, material, delete.
 *
 * Every step is placed rather than merely sequenced:
 * - Grants first. Revoke reads the owner bound on each grant at mint, so the
 *   order is not about ownership; ending the grants while their row still
 *   exists keeps them from outliving it un-revoked (TASK-145).
 * - Row second, because the broker refuses a row carrying `revokedAt` from that
 *   instant, however slow the vendor call turns out to be. `isActive` is left
 *   alone on purpose: the orphan sweep reads it, and it revokes the material of
 *   a row that is NOT active — the exact material step 4 has not spent yet.
 * - Provider third, while the material is still there. A hosted row sends the
 *   token to the entry's own RFC 7009 endpoint, so it needs no refresh first,
 *   and `credentialFor` would refuse the row step 2 has just marked.
 * - The mark immediately after the provider revoke TAKES, because a result code
 *   dies with the request and a retry reads only the row (§10.5). A retry that
 *   finds the mark skips the vendor: without it, a failure in steps 4 or 5
 *   leaves a row whose retry has no material to revoke with, so every retry
 *   refuses — measured. The mark is server-owned and a PATCH cannot
 *   write it: `SERVER_OWNED_CONFIG_KEYS` carries it and `stripServerOwnedConfig`
 *   drops it from the body before the write loop reads `relay.next`
 *   (`routes/integrations.ts:750-757`), pinned by
 *   `__tests__/unit/routes/integrations.serverOwnedConfig.test.js`.
 * - Material fourth and delete last, so a failed provider revoke leaves a row a
 *   retry can still finish. Reversing those two would destroy the only copy of
 *   the token that can be revoked at the vendor, leaving a live authorization
 *   nobody can reach — the state this sequence exists to avoid.
 *
 * The endpoint comes from the entry, never from discovery at removal time. An
 * entry is server-owned data that changes only by PR (§3), so a vendor moving
 * its metadata cannot redirect a revoke, and a row always revokes where it was
 * pinned to. Every entry names a `page` as well, and a removal that sends the
 * vendor nothing — no endpoint, or no token we hold — still finishes and hands
 * the person that page: a kept row there only waits for a retry that can never
 * succeed.
 *
 * The entry is read AGAIN at removal time, and code is deletable, so a row can
 * name an entry we no longer hold. The connect step copies the entry's `page`
 * onto the row (`config.revokePage`, also server-owned) for exactly that case:
 * the removal sends nothing, finishes, and hands over the copy — because the
 * authority to revoke by hand outlives the entry that named the endpoint. A row
 * connected before this copy existed has neither, and keeps the refusal.
 */
import Integration from '../models/Integration';
import {
  HOSTED_MCP_ENTRIES,
  findHostedMcpEntry,
  hostedMcpRevokeTarget,
} from '../integrations/hostedMcp/entries';
import { isOAuthEntry } from './hostedMcpEntryService';
import type { HostedMcpEntry, HostedMcpOAuthEntry } from './hostedMcpEntryService';
import {
  buildRevocationRequest,
  discoverAuthorizationServer,
  resolvedClientId,
  resolvedClientSecret,
  type HostedMcpClientConfiguration,
} from './hostedMcpIntakeService';
import * as connectorSecrets from './connectorSecrets';
import { upstreamFetch, UPSTREAM_TIMEOUT_MS } from './upstreamFetch';
import { hostedVendorFetch } from './hostedVendorFetch';
import { dcrClientForRow, refuseDcrClient } from './hostedMcpDcrRegistry';

export const HOSTED_MCP_TYPE = 'hosted-mcp';

/**
 * The row config key that records the provider revoke took. Server-owned (§3):
 * listed in `SERVER_OWNED_CONFIG_KEYS`, so the PATCH body is stripped before the
 * write loop sees it (`routes/integrations.ts:750-757`) — the strip, not an
 * explicit refusal, is what makes it unwritable, and
 * `__tests__/unit/routes/integrations.serverOwnedConfig.test.js` pins that.
 */
export const PROVIDER_REVOKED_MARK = 'providerRevokedAt';

/**
 * The row config key carrying the entry's `page` as it stood when the row was
 * connected. Server-owned for the same reason as the mark, and a sharper one: a
 * body that could write it would repoint the revocation a person is sent to.
 */
export const REVOKE_PAGE_KEY = 'revokePage';

/**
 * How long a removal holds the row against new writers (F34). It covers the
 * removal's own vendor round trip (discovery and the revoke, each bounded by
 * `UPSTREAM_TIMEOUT_MS`) with room to spare; a removal that dies leaves a lease
 * that expires on its own.
 */
export const REMOVAL_LEASE_MS = 60 * 1000;

/**
 * How long past its expiry a writer's lease still counts. A refresh's lease
 * (`REFRESH_LEASE_MS`) equals its two vendor calls' timeouts and nothing more,
 * so its puts can land just after it lapses.
 */
export const WRITER_LEASE_OVERRUN_MS = UPSTREAM_TIMEOUT_MS;

/** The row fields this sequence reads. Deliberately loose: a strict row type hides the schema change that matters. */
export interface RemovableConnection {
  _id?: unknown;
  type?: string;
  status?: string;
  revokedAt?: Date | null;
  config?: {
    entryId?: string;
    clientId?: string;
    credentialRef?: string;
    refreshTokenRef?: string;
    revokePage?: string;
    [PROVIDER_REVOKED_MARK]?: string | Date | null;
    authGeneration?: number;
    /** The write lease: a callback or refresh is putting material behind the refs until then. */
    refreshingUntil?: string | Date | null;
    /** The removal lease: a removal is revoking and sweeping until then. */
    removingUntil?: string | Date | null;
  };
}

export interface RemovalDeps {
  now: () => Date;
  /**
   * Step 2, and the fence (F34): one write that also moves the row's
   * authorization generation and drops any pending authorization, answered
   * with the row AFTER it. Everything removal reads about the row comes from
   * that answer. `isActive` is not among the fields, and must not be.
   */
  markDisconnected: (id: unknown, at: Date) => Promise<RemovableConnection | null>;
  /**
   * The removal lease, taken only while the row is still at `generation` and
   * no writer or other removal holds a lease. False means try again.
   */
  takeRemovalLease: (id: unknown, generation: number | undefined, until: Date, now: Date) => Promise<boolean>;
  /** Releases this removal's lease and no other; never throws. */
  releaseRemovalLease: (id: unknown, until: Date) => Promise<void>;
  /** Step 3b, between the provider revoke and any material going. Idempotent. */
  markProviderRevoked: (id: unknown, at: Date) => Promise<void>;
  entryFor: (connection: RemovableConnection) => HostedMcpEntry | null;
  clientIdFor: (entry: HostedMcpOAuthEntry) => string;
  clientSecretFor: (entry: HostedMcpOAuthEntry) => string | undefined;
  dcrClientForRow: typeof dcrClientForRow;
  /** Step 3. Resolves when the authorization is gone; throws when it may still be live. */
  revokeAtVendor: (input: {
    entry: HostedMcpOAuthEntry;
    clientId: string;
    clientSecret?: string;
    /** A DCR confidential client's registered method (TASK-248); sent as recorded. */
    tokenEndpointAuthMethod?: HostedMcpClientConfiguration['tokenEndpointAuthMethod'];
    token: string;
    tokenTypeHint: 'refresh_token' | 'access_token';
  }) => Promise<void>;
  secrets: Pick<typeof connectorSecrets, 'get' | 'revoke'>;
  /** Step 5. */
  remove: (id: unknown) => Promise<void>;
}

export type RemovalResult =
  | {
    removed: true;
    grantsRevoked: number;
    /** The entry's page, always: where a person revokes by hand, or confirms a revoke took (§3). */
    revokeAt: string;
    /**
     * Whether the vendor revoked the authorization, in this call or an earlier
     * one (the mark). False means the vendor was never told: a page-only entry,
     * no token left to send, or a client that no longer matches. The person
     * still has to remove the app at `revokeAt`, and the page must say so.
     */
    providerRevoked: boolean;
  }
  | {
    removed: false;
    /**
     * `provider_revoke_failed` — step 3 did not take, the row keeps its
     * references and a retry still holds the token to send.
     * `removal_busy` — a writer was storing a new token, or another removal
     * held the row (F34). Nothing was read or sent; the row is `disconnected`
     * and its grants are revoked, and a retry finishes it.
     * `provider_revoked_removal_incomplete` — step 3 is behind us and steps 4
     * or 5 failed; the retry finds the mark, skips the vendor, and finishes.
     * "Behind us" includes a step 3 that never called the vendor (a page-only
     * entry), so the name does not say the vendor revoked: `providerRevoked`
     * does.
     */
    code: 'provider_revoke_failed' | 'provider_revoked_removal_incomplete' | 'removal_busy';
    message: string;
    grantsRevoked: number;
    /** On `provider_revoked_removal_incomplete` only: as on success. */
    providerRevoked?: boolean;
    /** Present whenever the entry is known, so a person can act on the refusal itself (§10.5). */
    revokeAt?: string;
  };

/**
 * RFC 7009 at the entry's endpoint, which is the ONLY correct call when the
 * entry names one. A page never reaches here: it is for a person to visit, and
 * a page that answered this POST with 200 would read as a revoke that never
 * happened. Whether there is an endpoint at all comes from the entry
 * (`hostedMcpRevokeTarget`), never from the URL.
 *
 * Only a 2xx counts as revoked. RFC 7009 §2.2 answers 200 both for a revoke
 * that took and for a token the AS does not know, and that is the whole of the
 * evidence we accept. `invalid_grant` is NOT in that set, and used to be: RFC
 * 6749 §5.2 also gives it for a token "issued to another client", and a `cimd`
 * client id is a URL on the instance's API host (built at call time by
 * `resolvedClientId`), so after a host move this call would answer
 * `invalid_grant` while the authorization is perfectly live — counting it as
 * gone deletes the material and records a revoke that never happened.
 *
 * `unsupported_token_type` is out for the same reason: it says the AS will not
 * revoke this kind of token, so the token may still be live. The entry should
 * not pin an endpoint that refuses a refresh token, and the failure names the
 * endpoint that refused.
 */
export const revokeTokenAtVendor = async (input: {
  entry: HostedMcpOAuthEntry;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: HostedMcpClientConfiguration['tokenEndpointAuthMethod'];
  token: string;
  tokenTypeHint: 'refresh_token' | 'access_token';
}, fetchImpl: typeof fetch = hostedVendorFetch): Promise<void> => {
  const target = hostedMcpRevokeTarget(input.entry);
  if (!target?.endpoint) {
    throw new Error('provider revoke refused: entry names no RFC 7009 endpoint');
  }
  if (!input.token) {
    // Unreachable through `removeConnection`, which never calls this without a
    // token it read. Refused rather than sending `token: ""`, because RFC 7009
    // would answer the empty string 200 for a request that revoked nothing.
    throw new Error('provider revoke refused: no token to revoke');
  }
  // TASK-252: this request carries the token and, for a registered client, its
  // secret, so it goes only to the endpoint the issuer itself advertises. The
  // pin is reviewed by PR, but a vendor can move its endpoint, and an unchecked
  // pin would keep sending credentials to the old host. The metadata is read
  // with its identity checked (`discoverAuthorizationServer`), and the compare is
  // exact, as the issuer's is. Every pin equalled its issuer's
  // `revocation_endpoint` when this landed (measured 2026-11-01).
  const metadata = await discoverAuthorizationServer(input.entry.issuer, fetchImpl);
  if (metadata.revocation_endpoint !== target.endpoint) {
    throw new Error(
      `provider revoke refused: ${target.endpoint} is not the revocation_endpoint ${input.entry.issuer} advertises`,
    );
  }
  const request = buildRevocationRequest(
    input.entry,
    // Only a registered client reads its auth method from the metadata.
    input.entry.client === 'pre-registered' ? metadata : {},
    {
      clientId: input.clientId,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      ...(input.tokenEndpointAuthMethod ? { tokenEndpointAuthMethod: input.tokenEndpointAuthMethod } : {}),
    },
    { token: input.token, tokenTypeHint: input.tokenTypeHint },
  );
  const response = await upstreamFetch(target.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...request.headers,
    },
    body: request.body,
  }, fetchImpl);
  if (response.ok) return;
  if (input.entry.client === 'dcr') {
    const refusal = await response.json().catch(() => null) as { error?: unknown } | null;
    if (refusal?.error === 'invalid_client') {
      await refuseDcrClient(input.entry, input.clientId);
      const error = new Error('provider refused the registered client');
      Object.assign(error, { code: 'invalid_client' });
      throw error;
    }
  }
  throw new Error(`provider revoke refused: HTTP ${response.status}`);
};

export const defaultDeps = (): RemovalDeps => ({
  now: () => new Date(),
  // The generation and the pending authorization go in the same write as the
  // status. A callback that consumed its state before this write can no longer
  // retire or publish the row (both are guarded on the generation), a `/start`
  // that has not been consumed yet can no longer be, and a refresh can no
  // longer commit. Writers already past those guards hold the lease instead,
  // which `removeConnection` reads from this answer.
  markDisconnected: (id, at) => Integration.findOneAndUpdate(
    { _id: id },
    {
      $set: { status: 'disconnected', revokedAt: at },
      $inc: { 'config.authGeneration': 1 },
      $unset: { 'config.pendingAuth': '' },
    },
    { new: true },
  ).lean() as unknown as Promise<RemovableConnection | null>,
  takeRemovalLease: async (id, generation, until, now) => {
    const free = (path: string, at: Date) => ({
      $or: [{ [path]: { $exists: false } }, { [path]: null }, { [path]: { $lte: at } }],
    });
    const taken = await Integration.findOneAndUpdate(
      {
        _id: id,
        'config.authGeneration': generation === undefined ? { $exists: false } : generation,
        $and: [
          free('config.refreshingUntil', new Date(now.getTime() - WRITER_LEASE_OVERRUN_MS)),
          free('config.removingUntil', now),
        ],
      },
      { $set: { 'config.removingUntil': until } },
      { new: true },
    ).select('_id').lean();
    return taken !== null;
  },
  releaseRemovalLease: async (id, until) => {
    try {
      await Integration.updateOne(
        { _id: id, 'config.removingUntil': until },
        { $set: { 'config.removingUntil': null } },
      );
    } catch {
      // The lease expires on its own.
    }
  },
  markProviderRevoked: async (id, at) => {
    await Integration.updateOne(
      { _id: id },
      { $set: { [`config.${PROVIDER_REVOKED_MARK}`]: at.toISOString() } },
    );
  },
  entryFor: (connection) => findHostedMcpEntry(
    HOSTED_MCP_ENTRIES,
    String(connection?.config?.entryId || ''),
  ) || null,
  clientIdFor: (entry) => resolvedClientId(entry),
  clientSecretFor: (entry) => resolvedClientSecret(entry),
  dcrClientForRow,
  revokeAtVendor: (input) => revokeTokenAtVendor(input),
  secrets: connectorSecrets,
  remove: async (id) => {
    await Integration.findByIdAndDelete(id);
    // A removed row's credential no longer exists; discard its cached vendor
    // assessment as well rather than waiting for the five-minute TTL.
    const { forgetHostedMcpDrift } = await import('./hostedMcpToolDefinitions');
    forgetHostedMcpDrift(String(id));
  },
});

/** Only "we hold nothing to revoke" takes the swept path. Every other read failure keeps the row. */
const holdsNothingToRevoke = (error: unknown): boolean =>
  (error as { code?: string })?.code === 'connector_secret_not_found';

/**
 * `revokeGrants` is a required argument rather than a defaulted dep, because a
 * default would be a silent no-op on the one step whose omission recreates
 * TASK-145. A caller has to name it.
 */
/**
 * Steps 3 to 5, run only while the removal holds its lease: nothing can put new
 * material behind the refs in the meantime, so what is read here is what is
 * revoked and what is swept.
 */
const revokeThenSweep = async (input: {
  deps: RemovalDeps;
  id: unknown;
  entry: HostedMcpEntry | null;
  target: ReturnType<typeof hostedMcpRevokeTarget> | null;
  config: NonNullable<RemovableConnection['config']>;
  grantsRevoked: number;
  revokePage: string;
}): Promise<RemovalResult> => {
  const {
    deps, id, entry, target, config, grantsRevoked, revokePage,
  } = input;
  const refreshTokenRef = config.refreshTokenRef ? String(config.refreshTokenRef) : undefined;
  const credentialRef = config.credentialRef ? String(config.credentialRef) : undefined;

  // A retry after a completed provider revoke must not call the vendor again:
  // the material may be half-swept, and the token is already dead.
  const alreadyRevokedAtVendor = Boolean(config[PROVIDER_REVOKED_MARK]);
  let providerRevoked = alreadyRevokedAtVendor;

  // Only OAuth entries have a vendor revoke. An operator key is a static bearer
  // with no refresh token, so it is never sent to an RFC 7009 endpoint.
  if (entry && isOAuthEntry(entry) && target?.endpoint && !alreadyRevokedAtVendor) {
    // The row records which client minted this pair; the instance's current
    // configuration remains the source for client credentials. A recorded id
    // that differs from the current one must never send a held token under the
    // new client. During this first rollout, legacy rows without a snapshot use
    // the current Linear client; the post-rollout backfill closes that window.
    // A missing current client value hands the member the page instead.
    const recordedClientId = config.clientId;
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    let tokenEndpointAuthMethod: HostedMcpClientConfiguration['tokenEndpointAuthMethod'];
    let clientMatches = true;
    try {
      if (entry.client === 'dcr') {
        const recorded = await deps.dcrClientForRow(entry, recordedClientId);
        clientMatches = Boolean(recorded);
        clientId = recorded?.clientId;
        clientSecret = recorded?.clientSecret;
        tokenEndpointAuthMethod = recorded?.tokenEndpointAuthMethod;
      } else {
        clientId = deps.clientIdFor(entry);
        // During the first rollout legacy rows have no snapshot. The backfill
        // runs after the new callback is live, so those rows still use the
        // current Linear client until the snapshot is populated.
        clientMatches = !recordedClientId || clientId === recordedClientId;
        if (clientMatches) clientSecret = deps.clientSecretFor(entry);
      }
    } catch (error) {
      if ((error as { code?: string })?.code === 'client_not_configured') {
        clientMatches = false;
      } else {
        return {
          removed: false,
          code: 'provider_revoke_failed',
          message: (error as { message?: string })?.message || 'OAuth client configuration could not be read',
          grantsRevoked,
          revokeAt: revokePage,
        };
      }
    }

    if (clientMatches) {
      // The refresh token when the row has one, else the access token. A row can
      // carry either: what matters is that the token sent is one we HOLD, and
      // that an absent reference never becomes `token: ""` — RFC 7009 answers
      // that 200 for a request that revoked nothing.
      const tokenRef = refreshTokenRef || credentialRef;
      const tokenTypeHint = refreshTokenRef ? 'refresh_token' : 'access_token';

      // Both of the ways this stays null mean the same thing and take the same
      // path: no reference to read, or a secret that is not there. Nothing we
      // hold can revoke at the vendor, and a kept row only waits for a retry that
      // can never succeed — so the removal still finishes below, and the person
      // gets the page. Only an UNREADABLE secret refuses.
      let token: string | null = null;
      try {
        token = tokenRef ? await deps.secrets.get(tokenRef) : null;
      } catch (error) {
        if (!holdsNothingToRevoke(error)) {
          // `connector_secret_configuration_invalid` and
          // `connector_secret_key_missing` both land here, and they must: one
          // misconfigured key ring would otherwise delete every hosted row that
          // day while recording the vendor revoke as done. It may be readable
          // later, so the row keeps everything.
          return {
            removed: false,
            code: 'provider_revoke_failed',
            message: (error as { message?: string })?.message || 'connector secret unreadable',
            grantsRevoked,
            revokeAt: revokePage,
          };
        }
        token = null;
      }

      if (token) {
        try {
          await deps.revokeAtVendor({
            entry,
            clientId: clientId as string,
            ...(clientSecret ? { clientSecret } : {}),
            ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
            token,
            tokenTypeHint,
          });
        } catch (error) {
          if (entry.client === 'dcr' && (error as { code?: string })?.code === 'invalid_client') {
            // No usable client remains with which to revoke this token. The
            // registration is refused, so retries cannot change that result.
            // Finish locally and hand the person the vendor's revocation page.
            clientMatches = false;
          } else {
            // Steps 4 and 5 do not run. The row stays `disconnected` with both
            // references intact, and a retry still holds the token to send.
            return {
              removed: false,
              code: 'provider_revoke_failed',
              message: (error as { message?: string })?.message || 'provider revoke failed',
              grantsRevoked,
              revokeAt: revokePage,
            };
          }
        }

        // The provider revoke took. Record it BEFORE any material goes, so a
        // crash here leaves a row the retry finishes by skipping the vendor.
        if (clientMatches) {
          await deps.markProviderRevoked(id, deps.now());
          providerRevoked = true;
        }
      }
    }
  }

  try {
    await deps.secrets.revoke(refreshTokenRef);
    await deps.secrets.revoke(credentialRef);
    await deps.remove(id);
  } catch (error) {
    // A failure HERE is not a failed provider revoke, and saying so would send
    // a retry back to a vendor call that already happened.
    return {
      removed: false,
      code: 'provider_revoked_removal_incomplete',
      message: (error as { message?: string })?.message || 'removal incomplete after the provider revoke',
      grantsRevoked,
      revokeAt: revokePage,
      providerRevoked,
    };
  }

  return { removed: true, grantsRevoked, revokeAt: revokePage, providerRevoked };
};

export const removeConnection = async (options: {
  connection: RemovableConnection;
  removedBy: string;
  revokeGrants: (input: { connection: RemovableConnection; revokedBy: string }) => Promise<number>;
  deps?: Partial<RemovalDeps>;
}): Promise<RemovalResult> => {
  const deps: RemovalDeps = { ...defaultDeps(), ...options.deps };
  const { connection, removedBy } = options;
  const id = connection?._id;

  const grantsRevoked = await options.revokeGrants({ connection, revokedBy: removedBy });

  const entry = deps.entryFor(connection);

  // The row is marked BEFORE the entry is resolved, because resolving it is
  // part of step 3: an attempt that cannot complete must still leave the row
  // refusing at the broker. Marking is idempotent and the retry reads the
  // token directly, so a row left `disconnected` is still finishable.
  //
  // The refs, the mark and the lease are read from this write's answer, never
  // from `connection`. The caller read that before any writer could finish in
  // between: a mark read from it can skip the vendor for a token a reconnect
  // has since put behind the same refs (F34). A row already gone answers null,
  // and then there is nothing left here to revoke.
  const row = await deps.markDisconnected(id, deps.now());
  const config = row?.config || {};

  // The entry decides, and the decision is read once, here (§3). No endpoint
  // means no provider call at all; an endpoint means the token goes to it,
  // which is why the material must still exist at this point.
  const target = entry ? hostedMcpRevokeTarget(entry) : null;
  if (entry && !target) {
    return {
      removed: false,
      code: 'provider_revoke_failed',
      message: `hosted-mcp entry does not say how to revoke (${entry.id})`,
      grantsRevoked,
    };
  }

  // The page the person is handed: the entry's, when we still hold the entry;
  // otherwise the copy the connect step left on the row. A row naming an entry
  // we no longer hold is finishable ONLY through that copy — nothing is known
  // about where to revoke, so nothing is sent, and this is the authority the
  // person keeps. A row with neither keeps the refusal below, which is the only
  // case left: `entry` present with an unusable `revoke` returned above.
  const revokePage = target ? target.page : String(config[REVOKE_PAGE_KEY] || '');
  if (!revokePage) {
    return {
      removed: false,
      code: 'provider_revoke_failed',
      message: `hosted-mcp row names no known entry (${String(connection?.config?.entryId || '')})`,
      grantsRevoked,
    };
  }

  if (!row) {
    // Gone before this write: another removal finished it. Nothing was sent
    // from here, so nothing here can say the vendor revoked.
    return { removed: true, grantsRevoked, revokeAt: revokePage, providerRevoked: false };
  }

  // The removal's own lease (F34), taken only at the generation the write
  // above fenced and only when no writer holds the row's write lease. A
  // callback past its retire write, or a refresh past its fence, holds that
  // one while it puts new material behind the refs; its puts go to the secret
  // store, which no row write fences, so reading now could revoke the token it
  // is replacing and sweep the one it puts. While this lease is held, the
  // callback's retire write refuses, so a `/start` begun after the fence cannot
  // put anything either. A writer's lease counts until one vendor timeout past
  // its expiry, because a refresh's two vendor calls can use all of it.
  const removalLease = new Date(deps.now().getTime() + REMOVAL_LEASE_MS);
  const leased = await deps.takeRemovalLease(id, config.authGeneration, removalLease, deps.now());
  if (!leased) {
    return {
      removed: false,
      code: 'removal_busy',
      message: 'this connection is storing a new token; try again in a few seconds',
      grantsRevoked,
      revokeAt: revokePage,
    };
  }
  try {
    return await revokeThenSweep({
      deps, id, entry, target, config, grantsRevoked, revokePage,
    });
  } finally {
    await deps.releaseRemovalLease(id, removalLease);
  }
};

module.exports = {
  HOSTED_MCP_TYPE,
  PROVIDER_REVOKED_MARK,
  REVOKE_PAGE_KEY,
  REMOVAL_LEASE_MS,
  WRITER_LEASE_OVERRUN_MS,
  defaultDeps,
  removeConnection,
  revokeTokenAtVendor,
};
