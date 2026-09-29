/**
 * `credentialFor` — the one place a hosted-MCP connection's tokens are opened
 * (TASK-172, scope §10.3).
 *
 * The executing tool never sees which kind of credential it got: this returns
 * the same `{ token, expiresAt }` shape `githubAppService.getInstallationToken`
 * returns for the App row, and nothing that calls it can tell a hosted-MCP
 * member's token from an installation token.
 *
 * ## Why there is a fence
 *
 * A vendor's refresh token is single-use (GitHub's kills both itself and the old
 * access token when used). Two broker calls that both find the access token
 * expired and both refresh would leave one of them holding a dead pair on a
 * working Connection. So the refresh runs behind a conditional update that bumps
 * `refreshGeneration` from the value this caller read — exactly one caller wins
 * it.
 *
 * The rule that matters more than the win: **only the winner may touch the row's
 * status or revoke anything.** A loser re-reads, waits a bounded time for the
 * winner's write, and reports `credential_refreshing` — retryable — if it never
 * arrives. A loser that marked the row `error` or revoked the pair would turn a
 * working Connection into a broken one for a race it was never part of.
 *
 * The re-read is not the end of the fence because the old access token is dead
 * the moment the winner spends the refresh token: a loser that re-reads before
 * the winner has WRITTEN finds the old reference, which by then is already
 * useless. What the loser is waiting for is the winner's write, not the
 * generation bump.
 */

import Integration from '../models/Integration';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../integrations/hostedMcp/entries';
import type { HostedMcpEntry } from './hostedMcpEntryService';
import {
  buildRefreshBody,
  discoverAuthorizationServer,
  resolvedClientId,
} from './hostedMcpIntakeService';
import * as connectorSecrets from './connectorSecrets';
import { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } from './connectorSecretKinds';

/** Refresh this long before the vendor's expiry: a token that expires in flight is a failed call. */
export const EXPIRY_SKEW_MS = 60 * 1000;

/** How long a loser waits for the winner's provider call before reporting `credential_refreshing`. */
export const WINNER_WAIT_MS = 1500;

/** The loser's poll interval while it waits. */
const WINNER_POLL_MS = 100;

export type HostedMcpCredentialErrorCode =
  | 'connection_mismatch'
  | 'credential_missing'
  | 'refresh_unreachable'
  | 'connection_error'
  | 'credential_refreshing';

export class HostedMcpCredentialError extends Error {
  readonly code: HostedMcpCredentialErrorCode;

  /** Retryable means "the next call will work"; the broker must not spend this call's failure on the row. */
  readonly retryable: boolean;

  constructor(code: HostedMcpCredentialErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'HostedMcpCredentialError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface HostedMcpCredential {
  token: string;
  expiresAt: string;
}

/** The row fields this service reads. A strict row type would hide the schema change that matters. */
export interface HostedMcpRow {
  _id?: unknown;
  type?: string;
  status?: string;
  revokedAt?: Date | null;
  config?: {
    entryId?: string;
    credentialRef?: string;
    refreshTokenRef?: string;
    refreshGeneration?: number;
    expiresAt?: Date | null;
  };
}

interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

interface CredentialDeps {
  now: () => Date;
  entryFor: (row: HostedMcpRow) => HostedMcpEntry;
  clientIdFor: (entry: HostedMcpEntry) => string;
  refreshAtVendor: (input: {
    entry: HostedMcpEntry;
    clientId: string;
    refreshToken: string;
  }) => Promise<RefreshResult>;
  secrets: Pick<typeof connectorSecrets, 'get' | 'put' | 'revoke'>;
  row: {
    /** The row as it is NOW, by `_id` only: never a grant-supplied id (§10.3). */
    findById: (id: unknown) => Promise<HostedMcpRow | null>;
    /** The fence itself: bump the generation from the value the caller read, or return null. */
    bumpGeneration: (
      id: unknown,
      from: number,
    ) => Promise<HostedMcpRow | null>;
    /** Commit the winner's pair. Guarded on the generation it now holds. */
    commit: (id: unknown, generation: number, fields: Record<string, unknown>) => Promise<void>;
    /** The winner's error mark. Guarded the same way, so only the generation holder can set it. */
    markError: (id: unknown, generation: number, message: string) => Promise<void>;
  };
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): CredentialDeps => ({
  now: () => new Date(),
  entryFor: (row) => {
    const entry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, String(row.config?.entryId || ''));
    if (!entry) {
      throw new HostedMcpCredentialError(
        'connection_mismatch',
        `hosted-mcp row names no known entry (${String(row.config?.entryId || '')})`,
      );
    }
    return entry;
  },
  clientIdFor: (entry) => resolvedClientId(entry),
  refreshAtVendor: async ({ entry, clientId, refreshToken }) => {
    const { token_endpoint: tokenEndpoint } = await discoverAuthorizationServer(entry.issuer);
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: buildRefreshBody(entry, { clientId, refreshToken }),
    });
    const body = await response.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
    if (!response.ok) {
      const code = String(body.error || '');
      // `invalid_grant` is the vendor saying the refresh token itself is done:
      // revoked from the vendor's side, or run out its own lifetime. Everything
      // else — a 500, a 429, a body we cannot read — is the vendor having a bad
      // moment, and the next call should try again with the same pair.
      const definitive = code === 'invalid_grant' || response.status === 400 || response.status === 401;
      throw new HostedMcpCredentialError(
        definitive ? 'connection_error' : 'refresh_unreachable',
        `refresh refused (${response.status}${code ? ` ${code}` : ''})`,
        !definitive,
      );
    }
    if (!body.access_token) {
      throw new HostedMcpCredentialError('refresh_unreachable', 'refresh returned no access token', true);
    }
    return {
      accessToken: String(body.access_token),
      refreshToken: body.refresh_token ? String(body.refresh_token) : undefined,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : undefined,
    };
  },
  secrets: connectorSecrets,
  row: {
    findById: (id) => Integration.findById(id).lean() as unknown as Promise<HostedMcpRow | null>,
    bumpGeneration: (id, from) => Integration.findOneAndUpdate(
      { _id: id, 'config.refreshGeneration': from },
      { $inc: { 'config.refreshGeneration': 1 } },
      { new: false },
    ).lean() as unknown as Promise<HostedMcpRow | null>,
    commit: async (id, generation, fields) => {
      await Integration.findOneAndUpdate(
        { _id: id, 'config.refreshGeneration': generation },
        { $set: fields },
        { new: true },
      );
    },
    markError: async (id, generation, message) => {
      await Integration.findOneAndUpdate(
        { _id: id, 'config.refreshGeneration': generation },
        { $set: { status: 'error', errorMessage: message } },
        { new: true },
      );
    },
  },
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
});

/** `_id` only — a grant carries a connection id, and a hosted row is never found by one (§10.3). */
const rowId = (row: HostedMcpRow): unknown => {
  if (!row._id) throw new HostedMcpCredentialError('connection_mismatch', 'connection row has no _id');
  return row._id;
};

const assertUsable = (row: HostedMcpRow): void => {
  if (row.revokedAt) {
    throw new HostedMcpCredentialError('connection_mismatch', 'connection was removed');
  }
  // `error` is the winner's verdict on a definitive refusal; the broker refuses
  // on it exactly as it refuses a disconnected App row.
  if (row.status !== 'connected') {
    throw new HostedMcpCredentialError(
      'connection_mismatch',
      `connection is not connected (${String(row.status || 'unknown')})`,
    );
  }
};

const generationOf = (row: HostedMcpRow): number => Number(row.config?.refreshGeneration ?? 0);

const isFresh = (expiresAt: Date | null | undefined, now: Date): boolean => {
  // An absent lifetime is NOT fresh: `expires_in` is only RECOMMENDED, so a
  // vendor may omit it, and reading a missing value as "never expires" would
  // serve a token that has in fact already died. Refreshing is the safe reading;
  // `credentialFor` is where the case where refreshing is impossible becomes
  // visible to the member.
  if (!expiresAt) return false;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() - EXPIRY_SKEW_MS > now.getTime();
};

const isoOrEmpty = (expiresAt: Date | null | undefined): string => (
  expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : ''
);

/**
 * The credential for a hosted-MCP Connection, refreshed behind §10.3's fence.
 *
 * Refusals carry `retryable`: a `credential_refreshing` loser is a call that
 * should be made again, while a `connection_error` is a Connection the vendor
 * has already ended.
 */
export const credentialFor = async (
  row: HostedMcpRow,
  overrides: Partial<CredentialDeps> = {},
): Promise<HostedMcpCredential> => {
  const deps: CredentialDeps = { ...defaultDeps(), ...overrides };
  assertUsable(row);

  const id = rowId(row);
  const entry = deps.entryFor(row);
  const now = deps.now();
  const startRef = row.config?.credentialRef;

  if (startRef && isFresh(row.config?.expiresAt, now)) {
    // The common case, and the only one that touches nothing: a live access
    // token is returned without a fence, because there is nothing to race on.
    return { token: await deps.secrets.get(startRef), expiresAt: isoOrEmpty(row.config?.expiresAt) };
  }

  const generation = generationOf(row);
  const won = await deps.row.bumpGeneration(id, generation);

  if (!won) {
    return loseTheRace({ deps, id, startExpiresAt: row.config?.expiresAt });
  }

  // We hold the fence from here on, so this is the value every write below — and
  // every mark — is guarded on.
  const nextGeneration = generation + 1;

  const refreshTokenRef = row.config?.refreshTokenRef;
  if (!refreshTokenRef) {
    // Nothing to refresh with, and the access token has already stopped being
    // fresh (the fast path above did not return). Scope §4 says this row goes to
    // `error` with "reconnect": the spec allows an AS to issue no refresh token
    // at all, and nothing the vendor could answer restores such a row — only a
    // new consent does. Refusing without the mark leaves the row reading
    // `connected` on the page while every call fails, which is the one outcome
    // the member cannot act on.
    //
    // A rotating vendor does NOT arrive here: a response that omits the new
    // refresh token keeps the ref the row already holds (the commit below), so
    // this is only ever a grant that can no longer continue.
    const message = 'connection holds no refresh token and its access token has expired — reconnect to continue';
    await deps.row.markError(id, nextGeneration, message);
    throw new HostedMcpCredentialError('credential_missing', message);
  }

  const clientId = deps.clientIdFor(entry);
  const refreshToken = await deps.secrets.get(refreshTokenRef);

  let refreshed: RefreshResult;
  try {
    refreshed = await deps.refreshAtVendor({ entry, clientId, refreshToken });
  } catch (error) {
    const failure = error instanceof HostedMcpCredentialError
      ? error
      : new HostedMcpCredentialError('refresh_unreachable', String((error as Error)?.message || error), true);
    if (failure.code === 'connection_error') {
      // Only the generation holder may say a Connection is over, and it says so
      // only on the vendor's own refusal.
      await deps.row.markError(id, nextGeneration, failure.message);
    }
    throw failure;
  }

  const credentialRef = await deps.secrets.put(String(id), HOSTED_MCP_ACCESS_TOKEN, refreshed.accessToken);
  let nextRefreshRef = refreshTokenRef;
  if (refreshed.refreshToken) {
    // A vendor that rotates hands back a new refresh token; a vendor that does
    // not (or omits it in this response) keeps the one that still works.
    nextRefreshRef = await deps.secrets.put(String(id), HOSTED_MCP_REFRESH_TOKEN, refreshed.refreshToken);
  }

  const expiresAt = refreshed.expiresIn ? new Date(now.getTime() + refreshed.expiresIn * 1000) : null;
  await deps.row.commit(id, nextGeneration, {
    'config.credentialRef': credentialRef,
    'config.refreshTokenRef': nextRefreshRef,
    'config.expiresAt': expiresAt,
    // Top-level, not `config.*`: the row's error text lives outside the strict
    // subdocument, and clearing it inside one would be dropped in silence.
    errorMessage: null,
  });

  // Old references are revoked LAST: until the row points at the new ones, the
  // old secret is what a concurrent loser is reading.
  if (credentialRef !== startRef) await deps.secrets.revoke(startRef);
  if (nextRefreshRef !== refreshTokenRef) await deps.secrets.revoke(refreshTokenRef);

  return { token: refreshed.accessToken, expiresAt: isoOrEmpty(expiresAt) };
};

/**
 * The loser's path, and it is deliberately the one that can do no harm: re-read,
 * wait a bounded time for the winner to WRITE, and either serve the winner's
 * credential or report a retryable refusal. It never marks the row, never
 * revokes, and never refreshes.
 *
 * ## What the winner's write looks like from here
 *
 * Not a changed reference. `connectorSecrets.put` upserts on
 * `(integrationId, kind)`, so the ref for a given row and kind is STABLE across
 * puts: a refresh that replaces both halves of the pair leaves
 * `config.credentialRef` exactly as it was. Detection keyed on ref inequality
 * therefore never fires for a row that already held an (expired) credential —
 * which is the whole reason this path is reached — and the loser would poll out
 * its deadline and report `credential_refreshing` against a row the winner
 * finished committing milliseconds in.
 *
 * The signal that is actually observable is the one the caller could not have
 * seen before: the row's credential is FRESH. This path is entered only because
 * the pre-image was not fresh, so a fresh re-read is the winner's commit — or
 * another writer's, which is equally correct to serve. A re-read that finds the
 * old expiry (even though `put` has already overwritten the secret in place)
 * means the commit has not landed yet, and the loser keeps waiting: serving the
 * new token under the stale expiry would hand the caller a credential it would
 * immediately discard.
 */
const loseTheRace = async (input: {
  deps: CredentialDeps;
  id: unknown;
  /** The pre-image's expiry, which was NOT fresh — that is why this path is running. */
  startExpiresAt: Date | null | undefined;
}): Promise<HostedMcpCredential> => {
  const { deps, id } = input;
  const deadline = deps.now().getTime() + WINNER_WAIT_MS;

  for (;;) {
    const current = await deps.row.findById(id);
    // Gone while we waited: the Connection was removed. Refused as a mismatch
    // rather than as a retry, because no retry will find it.
    if (!current) {
      throw new HostedMcpCredentialError('connection_mismatch', 'connection was removed');
    }
    assertUsable(current);

    const ref = current.config?.credentialRef;
    const now = deps.now();
    // The pre-image's staleness is restated here rather than assumed: it is what
    // makes the check below mean "the winner wrote" instead of "it always was".
    const preImageWasStale = !isFresh(input.startExpiresAt, now);

    if (preImageWasStale && ref && isFresh(current.config?.expiresAt, now)) {
      return { token: await deps.secrets.get(ref), expiresAt: isoOrEmpty(current.config?.expiresAt) };
    }

    if (now.getTime() >= deadline) {
      throw new HostedMcpCredentialError(
        'credential_refreshing',
        'another call is refreshing this connection; retry',
        true,
      );
    }
    await deps.sleep(WINNER_POLL_MS);
  }
};
