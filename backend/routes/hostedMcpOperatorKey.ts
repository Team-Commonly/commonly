import type { Request, Response } from 'express';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../integrations/hostedMcp/entries';
import { isHostedMcpEntryHidden } from '../integrations/hostedMcp/visibility';
import { refusedOperatorKeyScopes, validateOperatorKey } from '../services/hostedMcpOperatorKeyIntake';
import { forgetHostedMcpDrift, guardedFetch } from '../services/hostedMcpToolDefinitions';
import { secretWriteGeneration } from '../services/hostedMcpSecretGeneration';
import { ownsRuntimeIdentity } from '../services/runtimeIdentityOwnership';

const Integration = require('../models/Integration');
const User = require('../models/User');
const connectorSecrets = require('../services/connectorSecrets');
const { HOSTED_MCP_ACCESS_TOKEN } = require('../services/connectorSecretKinds');
const { revokeConnectionGrants } = require('../services/roomGrantService');

type OperatorKeyRequest = Request & { user?: { id?: string } };

/**
 * POST /connect/hosted-mcp/:entryId/operator-key (TASK-330, Vera §5).
 *
 * Takes one agent's pasted key and makes it a connected row bound to that
 * agent. The key is proven by a live tools/list before the row can go
 * `connected`, is stored as a ConnectorSecret on the row (never on a grant),
 * and is never echoed in a response or written to a log.
 *
 * `scopeCheck` is always `self_report` here. Only a vendor readback of the
 * key's scopes may set `reportedScopes`, and no readback exists yet, so the
 * operator's scope picks are checked for refused scopes and nothing more.
 */
export const submitOperatorKey = async (req: OperatorKeyRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const entryId = String(req.params.entryId || '');
  const entry = findHostedMcpEntry(HOSTED_MCP_ENTRIES, entryId);
  if (!entry || isHostedMcpEntryHidden(entryId, process.env, userId)) {
    return res.status(404).json({ error: 'unknown_entry' });
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!/^[a-f\d]{24}$/i.test(agentId)) {
    return res.status(400).json({ error: 'invalid_agent', message: 'agentId must name an agent' });
  }
  const agent = await User.findOne({ _id: agentId, isBot: true }).select('_id botMetadata').lean();
  // The identity comes from the bot's own row, never the body, and is lowercased
  // as credentials.ts does. Refused before the probe, so a refused caller's key
  // never reaches the vendor.
  const agentName = String(agent?.botMetadata?.agentName || '').toLowerCase();
  const instanceId = String(agent?.botMetadata?.instanceId || '');
  if (!agent || !agentName || !instanceId) {
    return res.status(400).json({ error: 'invalid_agent', message: 'agentId must name an agent' });
  }
  // The key is a credential the agent presents, so it takes the same sole-installer
  // rule as a runtime token. Admins are not exempt.
  const ownership = await ownsRuntimeIdentity(userId, agentName, instanceId);
  if (!ownership.owned) {
    return res.status(403).json({
      error: 'agent_not_owned',
      failure: ownership.failure,
      message: 'you must be the sole installer of this agent',
    });
  }

  const picks = Array.isArray(body.scopePicks) ? body.scopePicks.map(String) : [];
  const refused = refusedOperatorKeyScopes(picks);
  if (refused.length > 0) {
    return res.status(400).json({
      error: 'scope_refused',
      message: `this key carries ${refused.join(', ')}; create a key without those scopes`,
    });
  }

  // Trimmed once, here: fetch strips header whitespace, so a pasted newline
  // would still authenticate while the stored copy no longer matched what a
  // vendor echoes, and the result redaction is an exact match.
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const intake = await validateOperatorKey({
    entry,
    key,
    reportedScopes: null,
    fetcher: guardedFetch,
  });
  if (!intake.ok) {
    const status = intake.code === 'vendor_unreachable' ? 502 : 400;
    return res.status(status).json({ error: intake.code, message: intake.message });
  }

  // The row is written only after the probe passes. It is upserted pending,
  // then the secret lands on it, then it goes connected: a failed write leaves
  // a pending row that grants refuse, never a connected row with no key.
  const row = await Integration.findOneAndUpdate(
    { type: 'hosted-mcp', createdBy: userId, 'config.entryId': entry.id, 'config.agentId': agentId },
    {
      $inc: { 'config.authGeneration': 1 },
      // A paste is a fresh connection: whatever a half-finished removal left on
      // the row (its revocation, error, provider-revoked mark) is not about
      // this key, and a surviving mark would let the next removal skip a step.
      $set: { status: 'pending', 'config.intake': 'operator_key', revokedAt: null, errorMessage: null },
      $unset: { 'config.providerRevokedAt': '' },
      $setOnInsert: {
        type: 'hosted-mcp',
        scope: 'user',
        createdBy: userId,
        'config.entryId': entry.id,
        'config.agentId': agentId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const generation = row.config?.authGeneration ?? 0;
  if (generation > 1) {
    // A grant was decided against the key connected then, and a pasted key
    // cannot prove it is the same account, so a re-paste ends them, as the OAuth
    // callback does for a subject it cannot compare (hostedMcpConnect.ts).
    await revokeConnectionGrants({ connection: row, revokedBy: userId });
    forgetHostedMcpDrift(String(row._id));
  }
  const writeGeneration = secretWriteGeneration(generation, 0);
  let credentialRef: string;
  try {
    credentialRef = await connectorSecrets.put(String(row._id), HOSTED_MCP_ACCESS_TOKEN, key, writeGeneration);
  } catch {
    // Fixed copy only: the store's error text stays out of the response.
    return res.status(500).json({ error: 'key_store_failed', message: 'the key could not be stored; try again' });
  }
  // Published only while the row is still the pending row this paste wrote. A
  // removal marks the row disconnected and revoked before it deletes it, so
  // the generation alone would let a paste that lands in between put that row
  // back to connected. The OAuth callback fences on its own interim status the
  // same way (hostedMcpConnect.ts).
  const published = await Integration.updateOne(
    {
      _id: row._id, 'config.authGeneration': generation, status: 'pending', revokedAt: null,
    },
    { $set: { status: 'connected', 'config.credentialRef': credentialRef } },
  );
  if (published?.matchedCount === 0) {
    // A removal took the row mid-paste (deleted it, or marked it on the way),
    // or a newer paste took it. Either way nothing will use this paste's key.
    // The ref is reused per row, so a newer paste may own it by now: delete
    // only while it still holds this paste's own write. A row lookup here
    // would race that newer paste, which can clear the mark and overwrite the
    // ref between the lookup and the delete.
    await connectorSecrets.revokeOwnWrite(credentialRef, writeGeneration);
    return res.status(409).json({
      error: 'connection_changed',
      message: 'the connection changed while the key was saved; paste it again',
    });
  }

  return res.status(201).json({
    integrationId: String(row._id),
    status: 'connected',
    scopeCheck: intake.scopeCheck,
    toolCount: intake.tools.length,
  });
};
