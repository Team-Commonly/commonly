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
const { HOSTED_MCP_ENTRIES, findHostedMcpEntry } = require('../integrations/hostedMcp/entries');
// eslint-disable-next-line global-require
const {
  HOSTED_MCP_PENDING_TTL_MS,
  buildAuthorizeUrl,
  buildClientMetadataDocument,
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

module.exports = router;
