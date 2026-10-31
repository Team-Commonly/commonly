import type { Request, Response } from 'express';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../integrations/hostedMcp/entries';
import { isHostedMcpEntryHidden } from '../integrations/hostedMcp/visibility';
import { refusedOperatorKeyScopes, validateOperatorKey } from '../services/hostedMcpOperatorKeyIntake';
import { guardedFetch } from '../services/hostedMcpToolDefinitions';
import { secretWriteGeneration } from '../services/hostedMcpSecretGeneration';
import { ownsRuntimeIdentity } from '../services/runtimeIdentityOwnership';

const Integration = require('../models/Integration');
const User = require('../models/User');
const connectorSecrets = require('../services/connectorSecrets');
const { HOSTED_MCP_ACCESS_TOKEN } = require('../services/connectorSecretKinds');

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
  const agentName = agent?.botMetadata?.agentName;
  const instanceId = agent?.botMetadata?.instanceId;
  if (!agent || !agentName || !instanceId) {
    return res.status(400).json({ error: 'invalid_agent', message: 'agentId must name an agent' });
  }
  // The key is a credential the agent presents, so it takes the same sole-installer
  // rule as a runtime token. Admins are not exempt.
  const ownership = await ownsRuntimeIdentity(userId, agentName, instanceId);
  if (!ownership.owned) {
    return res.status(403).json({ error: 'agent_not_owned', message: 'you must be the sole installer of this agent' });
  }

  const picks = Array.isArray(body.scopePicks) ? body.scopePicks.map(String) : [];
  const refused = refusedOperatorKeyScopes(picks);
  if (refused.length > 0) {
    return res.status(400).json({
      error: 'scope_refused',
      message: `this key carries ${refused.join(', ')}; create a key without those scopes`,
    });
  }

  const key = typeof body.key === 'string' ? body.key : '';
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
      $set: { status: 'pending', 'config.intake': 'operator_key' },
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
  const writeGeneration = secretWriteGeneration(row.config?.authGeneration ?? 0, 0);
  let credentialRef: string;
  try {
    credentialRef = await connectorSecrets.put(String(row._id), HOSTED_MCP_ACCESS_TOKEN, key, writeGeneration);
  } catch {
    // Fixed copy only: the store's error text stays out of the response.
    return res.status(500).json({ error: 'key_store_failed', message: 'the key could not be stored; try again' });
  }
  await Integration.updateOne(
    { _id: row._id },
    { $set: { status: 'connected', 'config.credentialRef': credentialRef } },
  );

  return res.status(201).json({
    integrationId: String(row._id),
    status: 'connected',
    scopeCheck: intake.scopeCheck,
    toolCount: intake.tools.length,
  });
};
