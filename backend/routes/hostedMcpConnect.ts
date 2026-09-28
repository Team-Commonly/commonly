/**
 * The public half of hosted-MCP intake (TASK-172, scope §4): the Client ID
 * Metadata Document, and the start route that sends a member to their vendor's
 * consent screen.
 *
 * Mounted under `/api/integrations/connect/hosted-mcp` by
 * `routes/integrations.ts`, on a path deeper than `/:podId` so an entry id can
 * never be read as a pod id.
 *
 * The document is unauthenticated on purpose and holds nothing to protect: the
 * authorization server fetches it before any member has consented, and it is
 * the same document for every member of the instance (one client id per
 * instance per entry, §4). A per-person client would need registration per
 * person, which is the thing CIMD exists to avoid.
 */
const express = require('express');
import type { Request, Response } from 'express';
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
import { writeIntegrationsRateLimit } from '../middleware/integrationRateLimit';
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const connectorSecrets = require('../services/connectorSecrets');
// eslint-disable-next-line global-require
const { HOSTED_MCP_ACCESS_TOKEN, HOSTED_MCP_REFRESH_TOKEN } = require('../services/connectorSecretKinds');
// eslint-disable-next-line global-require
const { revokeConnectionGrants } = require('../services/roomGrantService');
// eslint-disable-next-line global-require
const { HOSTED_MCP_ENTRIES, findHostedMcpEntry } = require('../integrations/hostedMcp/entries');
// eslint-disable-next-line global-require
const {
  HOSTED_MCP_PENDING_TTL_MS,
  buildAuthorizeUrl,
  buildClientMetadataDocument,
  buildTokenExchangeBody,
  createPkcePair,
  createStateNonce,
  discoverAuthorizationServer,
  hostedMcpCallbackUrl,
  resolvedClientId,
} = require('../services/hostedMcpIntakeService');

type AuthedRequest = Request & { user?: { id?: string; role?: string } };

/** A vendor-side failure is not the caller's fault and not a 4xx. */
const vendorFailureStatus = (code?: string): number => (
  code === 'issuer_unreachable' || code === 'issuer_metadata_incomplete' ? 502 : 503
);

/**
 * The browser comes back here, so every outcome is a redirect and not JSON:
 * a person who refused consent has to land on the page that can offer Connect
 * again. Mirrors the Slack callback's `?slack=` contract in shape.
 */
const publicAppUrl = (): string => {
  const configured = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://commonly.me')
    .split(',')[0]
    .trim();
  return (configured || 'https://commonly.me').replace(/\/+$/, '');
};

const callbackRedirect = (res: Response, status: string, code?: string) => {
  const query = new URLSearchParams({ hostedMcp: status });
  if (code) query.set('code', code);
  return res.redirect(302, `${publicAppUrl()}/v2/connectors?${query.toString()}`);
};

/**
 * `sub` from an ID token the token endpoint handed us over TLS in answer to our
 * own exchange. The signature is not verified because there is no third party
 * here to defend against: we are not accepting this token from anyone, and the
 * claims only need to be as trustworthy as the response they arrived in. This
 * is the only source of `providerSubject`, §2's account-change key, so a
 * vendor that issues no ID token leaves it undefined and §2's comparison falls
 * to the "cannot be compared" arm.
 */
const idTokenSubject = (idToken?: string): string | undefined => {
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : undefined;
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/:entryId/client-metadata', (req: Request, res: Response) => {
  const entry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, req.params.entryId);
  if (!entry) {
    // An unknown entry is a 404 and not a document with empty fields: a
    // document that names no redirect URI is one an authorization server could
    // still accept as a client with nowhere to send a code.
    return res.status(404).json({ error: 'unknown_entry' });
  }
  return res.json(buildClientMetadataDocument(entry));
});

/**
 * Begin a connect. Discovery runs BEFORE the row is written, so a vendor outage
 * leaves no pending row behind — a row whose only content is a dead nonce is a
 * connect the page would show as in progress and nothing would ever finish.
 *
 * The row is found by `(createdBy, config.entryId)` in the filter rather than
 * inserted blind, because §2 allows exactly one row per person per entry: a
 * second Connect reuses the row's pending state and the callback replaces the
 * pair through the §10.3 fence. An insert here would collide with the partial
 * unique index instead.
 */
router.post('/:entryId/start', writeIntegrationsRateLimit, auth, async (req: AuthedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  const entry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, req.params.entryId);
  if (!entry) {
    return res.status(404).json({ error: 'unknown_entry' });
  }

  let clientId: string;
  try {
    clientId = resolvedClientId(entry);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return res.status(vendorFailureStatus(code)).json({ error: code });
  }

  let authorizationEndpoint: string;
  try {
    ({ authorization_endpoint: authorizationEndpoint } = await discoverAuthorizationServer(entry.issuer));
  } catch (error) {
    const code = (error as { code?: string }).code;
    return res.status(vendorFailureStatus(code)).json({ error: code });
  }

  const { verifier, challenge } = createPkcePair();
  const state = createStateNonce();
  const expiresAt = new Date(Date.now() + HOSTED_MCP_PENDING_TTL_MS);
  const redirectUri = hostedMcpCallbackUrl(entry.id);

  // `intake` is written here as well as at the callback: it is the one field
  // that says which flow owns the pending state, and a row left `pending` with
  // no nonce would otherwise be indistinguishable from one whose nonce expired.
  const row = await Integration.findOneAndUpdate(
    { type: 'hosted-mcp', createdBy: userId, 'config.entryId': entry.id },
    {
      $set: {
        'config.intake': 'oauth',
        'config.pendingAuth': { state, codeVerifier: verifier, expiresAt },
      },
      $setOnInsert: {
        type: 'hosted-mcp',
        scope: 'user',
        status: 'pending',
        createdBy: userId,
        'config.entryId': entry.id,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return res.json({
    authorizeUrl: buildAuthorizeUrl(entry, authorizationEndpoint, {
      clientId, redirectUri, state, codeChallenge: challenge,
    }),
    expiresAt,
    integrationId: row?._id,
  });
});

/**
 * The callback (§4). Everything a member consented to is spent by the time we
 * get here, so the state is consumed BEFORE the exchange: a state that could be
 * spent twice is a second consent nobody gave, and a vendor code replayed at
 * the token endpoint is a code the AS may have already retired.
 *
 * The claim is `$unset` of `pendingAuth` rather than the Slack callback's
 * `claimId`, and not by preference: `config.pendingAuth` is a strict subdocument
 * (`models/Integration.ts:375`), so a `claimId` written onto it is dropped
 * silently and no row would ever appear claimed. Consuming the whole subdocument
 * is atomic on the same terms and hands back the verifier in the pre-image,
 * which is the only place it is kept.
 */
router.get('/:entryId/callback', async (req: Request, res: Response) => {
  const entry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, req.params.entryId);
  if (!entry) {
    return callbackRedirect(res, 'error', 'unknown_entry');
  }
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!state || !code) {
    return callbackRedirect(res, 'error', 'invalid_state');
  }
  // RFC 9207. Absent is not a refusal — a vendor that sends no `iss` still had
  // its code delivered to a redirect URI naming THIS entry — but a present and
  // different one is another authorization server's answer.
  const iss = typeof req.query.iss === 'string' ? req.query.iss : '';
  if (iss && iss !== entry.issuer) {
    return callbackRedirect(res, 'error', 'issuer_mismatch');
  }

  const now = new Date();
  const issued = await Integration.findOne({
    type: 'hosted-mcp', 'config.entryId': entry.id, 'config.pendingAuth.state': state,
  });
  if (!issued) {
    return callbackRedirect(res, 'error', 'invalid_state');
  }
  const expiresAt = issued.config?.pendingAuth?.expiresAt;
  if (!expiresAt || new Date(expiresAt).getTime() <= now.getTime()) {
    return callbackRedirect(res, 'error', 'state_expired');
  }

  const codeVerifier = issued.config?.pendingAuth?.codeVerifier;
  const consumed = await Integration.findOneAndUpdate(
    {
      _id: issued._id,
      'config.pendingAuth.state': state,
      'config.pendingAuth.expiresAt': { $gt: now },
    },
    { $unset: { 'config.pendingAuth': 1 } },
    { new: false },
  );
  if (!consumed || !codeVerifier) {
    // A second delivery of the same state, or two tabs finishing at once.
    return callbackRedirect(res, 'error', 'state_consumed');
  }

  let tokenEndpoint: string;
  try {
    ({ token_endpoint: tokenEndpoint } = await discoverAuthorizationServer(entry.issuer));
  } catch (error) {
    return callbackRedirect(res, 'error', (error as { code?: string }).code || 'issuer_unreachable');
  }

  let tokens: TokenResponse;
  try {
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: buildTokenExchangeBody(entry, {
        clientId: resolvedClientId(entry),
        redirectUri: hostedMcpCallbackUrl(entry.id),
        code,
        codeVerifier,
      }),
    });
    if (!response.ok) {
      return callbackRedirect(res, 'error', 'exchange_refused');
    }
    tokens = (await response.json()) as TokenResponse;
  } catch {
    return callbackRedirect(res, 'error', 'exchange_unreachable');
  }
  if (!tokens?.access_token) {
    return callbackRedirect(res, 'error', 'exchange_incomplete');
  }

  const owner = String(consumed.createdBy);
  // The credential half of the row lives under `config` (a strict
  // subdocument), so a top-level read is `undefined` on every real row: the
  // account-change rule would never fire and the retired refresh token would
  // never be dropped. The arms below read the same shape.
  const previousSubject = consumed.config?.providerSubject || undefined;
  const providerSubject = idTokenSubject(tokens.id_token);
  // §2: a grant was made against the reach of the account connected at the
  // time, and the row's `createdAt` survives a reconnect, so the broker's
  // TASK-148 guard cannot see this one. An unknowable subject revokes too —
  // assuming the account is unchanged is the assumption that costs the most.
  const accountChanged = Boolean(consumed.config?.credentialRef)
    && (!providerSubject || !previousSubject || providerSubject !== previousSubject);
  if (accountChanged) {
    await revokeConnectionGrants({ connection: consumed, revokedBy: owner });
  }

  const credentialRef = await connectorSecrets.put(String(consumed._id), HOSTED_MCP_ACCESS_TOKEN, tokens.access_token);
  let refreshTokenRef = consumed.config?.refreshTokenRef || undefined;
  if (tokens.refresh_token) {
    refreshTokenRef = await connectorSecrets.put(String(consumed._id), HOSTED_MCP_REFRESH_TOKEN, tokens.refresh_token);
  } else if (refreshTokenRef) {
    // The AS answered without a refresh token, so the one on the row is from a
    // grant that no longer exists. Keeping it would leave the mint refreshing
    // against a retired token and calling the failure a vendor outage.
    await connectorSecrets.revoke(refreshTokenRef);
    refreshTokenRef = undefined;
  }

  await Integration.findOneAndUpdate(
    { _id: consumed._id },
    {
      $set: {
        status: 'connected',
        // Every one of these is a `config.*` path: `config` is a STRICT
        // subdocument, so an unprefixed `credentialRef` is dropped in silence
        // and this handler reports a Connection whose row holds no token (see
        // the model's note, and the arm that now reads the schema).
        'config.credentialRef': credentialRef,
        'config.refreshTokenRef': refreshTokenRef || null,
        'config.refreshGeneration': 0,
        'config.grantedScope': tokens.scope || entry.scopes.join(' '),
        'config.expiresAt': tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        'config.providerSubject': providerSubject,
        revokedAt: null,
        errorMessage: null,
      },
    },
    { new: true },
  );

  return callbackRedirect(res, 'connected');
});

module.exports = router;
