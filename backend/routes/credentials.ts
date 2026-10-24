// ADR-026 Phase 0: credential listing + revocation. Revocation cascades to
// every descendant (daemon → minted runtime tokens) — the property the
// embedded token records could never provide. Owner or instance admin only.
import express from 'express';
import { Types } from 'mongoose';
// ESM import (not require) so CodeQL's js/missing-rate-limiting query
// recognizes the limiter (same pattern as routes/messages.ts).
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { createHash } from 'crypto';
import AgentCredential from '../models/AgentCredential';
import { AgentInstallation } from '../models/AgentRegistry';
import { ownsRuntimeIdentity } from '../services/runtimeIdentityOwnership';
import { revokeRuntimeTokenEverywhere } from './registry/tokens';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

const router = express.Router();

// Token-hash/IP keyed, same shape as the messages read limiter. Credential
// operations are rare; tight caps are free safety.
const credentialRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { get?: (h: string) => string | undefined; ip?: string }) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return cloudflareIpRateLimitKeyGenerator(req as never);
  },
  handler: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 60 credential ops per 60s' });
  },
});

type AuthReq = express.Request & { user?: { id?: string } };

router.get('/', credentialRateLimit, auth, async (req: AuthReq, res: express.Response) => {
  try {
    const agentName = String(req.query.agentName || '').trim().toLowerCase();
    const instanceId = String(req.query.instanceId || '').trim();
    let filter: Record<string, unknown> = { ownerUserId: req.user?.id };
    if (agentName || instanceId) {
      if (!agentName || !instanceId) return res.status(400).json({ message: 'Agent name and instance id are required' });
      const caller = await User.findById(req.user?.id).select('role').lean();
      if (caller?.role !== 'admin') {
        const ownership = await ownsRuntimeIdentity(req.user?.id, agentName, instanceId);
        if (!ownership.owned) return res.status(403).json({ message: 'Access denied' });
      }
      const agent = await User.findOne({
        isBot: true,
        'botMetadata.agentName': agentName,
        'botMetadata.instanceId': instanceId,
      }).select('_id agentRuntimeTokens').lean();
      if (!agent) return res.status(404).json({ message: 'Agent not found' });
      // Existing CLI keys were minted before the credential ledger became
      // authoritative. Import their metadata once so list/revoke can use the
      // same credential id and a later revoke remains visible in Settings.
      const installations = await AgentInstallation.find({ agentName, instanceId })
        .select('installedBy runtimeTokens').lean();
      const ownerUserId = installations[0]?.installedBy || req.user?.id;
      type EmbeddedToken = { tokenHash?: string; label?: string; createdAt?: Date; lastUsedAt?: Date };
      const embedded: EmbeddedToken[] = [...(agent.agentRuntimeTokens || []),
        ...installations.flatMap((entry: { runtimeTokens?: EmbeddedToken[] }) => entry.runtimeTokens || [])];
      const seen = new Set<string>();
      await Promise.all(embedded.filter((token) => {
        if (!token.tokenHash || seen.has(token.tokenHash)) return false;
        seen.add(token.tokenHash);
        return true;
      })
        .map((token) => AgentCredential.updateOne(
          { tokenHash: token.tokenHash },
          { $setOnInsert: {
            kind: 'runtime', ownerUserId, agentUserId: agent._id,
            label: token.label || 'Runtime token', status: 'active',
            createdAt: token.createdAt || new Date(), lastUsedAt: token.lastUsedAt || null,
          } },
          { upsert: true },
        )));
      filter = { agentUserId: agent._id, kind: 'runtime' };
    }
    const rows = await AgentCredential.find(filter)
      .select('-tokenHash')
      .sort({ createdAt: -1 })
      .lean();
    return res.json(rows);
  } catch (err) {
    console.error('Error listing credentials:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', credentialRateLimit, auth, async (req: AuthReq, res: express.Response) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid credential id' });
    const credential = await AgentCredential.findById(id);
    if (!credential) return res.status(404).json({ message: 'Credential not found' });
    const caller = await User.findById(req.user?.id).select('role').lean();
    const agentName = String(req.query.agentName || '').trim().toLowerCase();
    const instanceId = String(req.query.instanceId || '').trim();
    if (agentName || instanceId) {
      if (!agentName || !instanceId) return res.status(400).json({ message: 'Agent name and instance id are required' });
      const agent = await User.findOne({
        isBot: true,
        'botMetadata.agentName': agentName,
        'botMetadata.instanceId': instanceId,
      }).select('_id').lean();
      if (!agent || String(credential.agentUserId) !== String(agent._id) || credential.kind !== 'runtime') {
        return res.status(404).json({ message: 'Credential not found for this agent' });
      }
      if (caller?.role !== 'admin') {
        const ownership = await ownsRuntimeIdentity(req.user?.id, agentName, instanceId);
        if (!ownership.owned) return res.status(403).json({ message: 'Access denied' });
      }
    }
    const isOwner = String(credential.ownerUserId) === String(req.user?.id);
    if (!agentName && !isOwner && caller?.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    // Capture descendant hashes before the cascade. A daemon revoke also
    // invalidates runtime children, whose embedded copies must be removed.
    const runtimeHashes = new Set<string>();
    let frontier: Types.ObjectId[] = [credential._id as Types.ObjectId];
    while (frontier.length) {
      const rows = await AgentCredential.find({ _id: { $in: frontier } })
        .select('_id kind tokenHash').lean();
      for (const row of rows) {
        if (row.kind === 'runtime' && row.tokenHash) runtimeHashes.add(row.tokenHash);
      }
      const children = await AgentCredential.find({ parentId: { $in: frontier } }).select('_id').lean();
      frontier = children.map((row) => row._id as Types.ObjectId);
    }
    const revoked = await AgentCredential.revokeCascade(credential._id as Types.ObjectId);
    await Promise.all([...runtimeHashes].map((tokenHash) => revokeRuntimeTokenEverywhere(tokenHash)));
    return res.json({ revoked });
  } catch (err) {
    console.error('Error revoking credential:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
export {};
