/**
 * The public half of hosted-MCP intake (TASK-172, scope §4): the Client ID
 * Metadata Document, and — as step 3 completes — the start and callback
 * routes that drive a member through their vendor's consent screen.
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
const { HOSTED_MCP_ENTRIES, findHostedMcpEntry } = require('../integrations/hostedMcp/entries');
const { buildClientMetadataDocument } = require('../services/hostedMcpIntakeService');

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

module.exports = router;
