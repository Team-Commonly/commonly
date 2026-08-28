// ADR-026 Phase 0: credential listing + revocation. Revocation cascades to
// every descendant (daemon → minted runtime tokens) — the property the
// embedded token records could never provide. Owner or instance admin only.
import express from 'express';
import { Types } from 'mongoose';
// ESM import (not require) so CodeQL's js/missing-rate-limiting query
// recognizes the limiter (same pattern as routes/messages.ts).
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
import AgentCredential from '../models/AgentCredential';

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
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 60 credential ops per 60s' });
  },
});

type AuthReq = express.Request & { user?: { id?: string } };

router.get('/', credentialRateLimit, auth, async (req: AuthReq, res: express.Response) => {
  try {
    const rows = await AgentCredential.find({ ownerUserId: req.user?.id })
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
    const isOwner = String(credential.ownerUserId) === String(req.user?.id);
    if (!isOwner && caller?.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    const revoked = await AgentCredential.revokeCascade(credential._id as Types.ObjectId);
    return res.json({ revoked });
  } catch (err) {
    console.error('Error revoking credential:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
export {};
