// Pod invite tokens — shareable URLs that let a user join a pod without
// going through the invite-only joinPolicy gate. Tokens are random
// (16-byte hex), DB-backed (PodInvite), and bound to a single pod by their
// creator. Authenticated users resolve + redeem; anonymous visitors get a
// minimal PREVIEW (pod name + member count only) so a shared link can show
// "you've been invited to X — sign up to join" instead of a blank login wall.
import express from 'express';
import crypto, { createHash } from 'crypto';
import mongoose from 'mongoose';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
const router = express.Router();
const auth = require('../middleware/auth');
const Pod = require('../models/Pod');
const { PodInvite } = require('../models/PodInvite');

const getUserId = (req: any) => req.userId || req.user?.id || req.user?._id;

// Same token/IP keying as the messages-router limiters (#614). The preview
// endpoint is anonymous and DB-backed, so it gets a tight IP bucket — it's
// also the token-enumeration surface, and the limiter is the brake on that.
const inviteRateLimitKey = (req: any) => {
  const authHeader = req.get?.('authorization') || req.get?.('x-auth-token');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

const inviteReadRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: inviteRateLimitKey,
  handler: (_req: any, res: any) => res.status(429).json({ msg: 'rate limit exceeded: 60 invite reads per 60s' }),
});

const inviteWriteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: inviteRateLimitKey,
  handler: (_req: any, res: any) => res.status(429).json({ msg: 'rate limit exceeded: 20 invite writes per 60s' }),
});

// eslint-disable-next-line global-require
const isPodMember = require('../utils/isPodMember');

// POST /api/pods/:podId/invites — issue a fresh invite token. Caller must
// be a member or creator. Body: { expiresInHours?, maxUses? } — both
// optional; null = unlimited.
router.post('/pods/:podId/invites', inviteWriteRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });
    const pod = await Pod.findById(req.params.podId);
    if (!pod) return res.status(404).json({ msg: 'Pod not found' });
    if (!isPodMember(pod, userId)) {
      return res.status(403).json({ msg: 'Only pod members can create invites' });
    }
    const { expiresInHours, maxUses } = req.body || {};
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = expiresInHours && Number(expiresInHours) > 0
      ? new Date(Date.now() + Number(expiresInHours) * 3600 * 1000)
      : null;
    const invite = await PodInvite.create({
      token,
      podId: pod._id,
      createdBy: userId,
      expiresAt,
      maxUses: maxUses && Number(maxUses) > 0 ? Number(maxUses) : null,
    });
    return res.status(201).json({
      token: invite.token,
      podId: pod._id,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      createdAt: invite.createdAt,
    });
  } catch (err: any) {
    console.error('Create invite failed:', err.message);
    return res.status(500).json({ msg: err.message || 'Failed to create invite' });
  }
});

// GET /api/pods/:podId/invites — list the active invite links a pod member
// can manage. Revoked rows stay in the database for auditability but never
// return to the shell.
router.get('/pods/:podId/invites', inviteReadRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });
    const rawPodId = String(req.params.podId || '');
    if (!mongoose.Types.ObjectId.isValid(rawPodId)) {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    const podId = new mongoose.Types.ObjectId(rawPodId);
    const pod = await Pod.findById(podId);
    if (!pod) return res.status(404).json({ msg: 'Pod not found' });
    if (!isPodMember(pod, userId)) {
      return res.status(403).json({ msg: 'Only pod members can manage invites' });
    }
    const invites = await PodInvite.find({ podId: pod._id, revokedAt: null })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'username profilePicture')
      .lean();
    return res.json(invites.map((invite: any) => ({
      token: invite.token,
      createdBy: invite.createdBy,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      uses: Number(invite.useCount) || 0,
    })));
  } catch (err: any) {
    console.error('List invites failed:', err.message);
    return res.status(500).json({ msg: err.message || 'Failed to list invites' });
  }
});

// DELETE /api/invites/:token — revoke an invite without deleting its audit
// row. Any pod member may revoke any link, matching the existing member-level
// permission to create links for that pod.
router.delete('/invites/:token', inviteWriteRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });
    const rawToken = req.params.token;
    if (typeof rawToken !== 'string') {
      return res.status(404).json({ msg: 'Invite not found' });
    }
    const safeToken = String(rawToken).toLowerCase().replace(/[^a-f0-9]/g, '');
    if (!safeToken || safeToken !== rawToken.toLowerCase() || !/^[a-f0-9]{32}$/.test(safeToken)) {
      return res.status(404).json({ msg: 'Invite not found' });
    }
    const invite = await PodInvite.findOne({ token: safeToken });
    if (!invite) return res.status(404).json({ msg: 'Invite not found' });
    const pod = await Pod.findById(invite.podId);
    if (!pod) return res.status(404).json({ msg: 'Pod not found' });
    if (!isPodMember(pod, userId)) {
      return res.status(403).json({ msg: 'Only pod members can manage invites' });
    }
    if (!invite.revokedAt) {
      invite.revokedAt = new Date();
      await invite.save();
    }
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('Revoke invite failed:', err.message);
    return res.status(500).json({ msg: err.message || 'Failed to revoke invite' });
  }
});

// GET /api/invites/:token/preview — ANONYMOUS, minimal disclosure. Lets the
// redeem page show "you've been invited to <pod>" to logged-out visitors so
// a shared link funnels into signup instead of a context-free login wall.
// Returns pod NAME + member count only: no podId, no description, no member
// identities. Invalid/expired/DM-pod invites all collapse to the same 404 so
// the endpoint can't be used to probe which tokens exist for what.
router.get('/invites/:token/preview', inviteReadRateLimit, async (req: any, res: any) => {
  try {
    const invite = await PodInvite.findOne({ token: req.params.token });
    if (!invite || !invite.isUsable()) {
      return res.status(404).json({ msg: 'Invite invalid or expired' });
    }
    const pod = await Pod.findById(invite.podId).select('_id name type members').lean();
    if (!pod) return res.status(404).json({ msg: 'Invite invalid or expired' });
    const { DM_POD_TYPES_GUARD } = require('../services/agentIdentityService');
    if (DM_POD_TYPES_GUARD.has(String(pod.type))) {
      // Not redeemable anyway — don't advertise the pod's existence.
      return res.status(404).json({ msg: 'Invite invalid or expired' });
    }
    return res.json({
      pod: {
        name: pod.name,
        memberCount: (pod.members || []).length,
      },
      expiresAt: invite.expiresAt,
    });
  } catch (err: any) {
    console.error('Preview invite failed:', err.message);
    return res.status(500).json({ msg: 'Failed to preview invite' });
  }
});

// GET /api/invites/:token — resolve token to public pod info. Auth required
// (we don't reveal pod existence to anonymous callers).
router.get('/invites/:token', inviteReadRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });
    const invite = await PodInvite.findOne({ token: req.params.token });
    if (!invite || !invite.isUsable()) {
      return res.status(404).json({ msg: 'Invite invalid or expired' });
    }
    const pod = await Pod.findById(invite.podId)
      .select('_id name description type members createdAt')
      .lean();
    if (!pod) return res.status(404).json({ msg: 'Pod no longer exists' });
    const alreadyMember = (pod.members || []).some(
      (m: any) => String(m?._id || m) === String(userId),
    );
    return res.json({
      token: invite.token,
      pod: {
        _id: pod._id,
        name: pod.name,
        description: pod.description,
        type: pod.type,
        memberCount: (pod.members || []).length,
      },
      alreadyMember,
      expiresAt: invite.expiresAt,
    });
  } catch (err: any) {
    console.error('Resolve invite failed:', err.message);
    return res.status(500).json({ msg: err.message || 'Failed to resolve invite' });
  }
});

// POST /api/invites/:token/redeem — add caller to pod members (idempotent).
// Increments useCount. Bypasses the pod's invite-only joinPolicy because
// the token IS the invite. Personal DM pods (agent-room/agent-dm) are
// strictly 1:1 and refuse — agent-admin stays invitable by design.
router.post('/invites/:token/redeem', inviteWriteRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ msg: 'Unauthorized' });
    const invite = await PodInvite.findOne({ token: req.params.token });
    if (!invite || !invite.isUsable()) {
      return res.status(404).json({ msg: 'Invite invalid or expired' });
    }
    const pod = await Pod.findById(invite.podId);
    if (!pod) return res.status(404).json({ msg: 'Pod no longer exists' });
    const { DM_POD_TYPES_GUARD } = require('../services/agentIdentityService');
    if (DM_POD_TYPES_GUARD.has(String(pod.type))) {
      return res.status(403).json({
        code: 'dm_membership_refused',
        msg: 'DM pods are 1:1 — invite links cannot grant third-party access. Start a new DM instead.',
      });
    }
    const alreadyMember = (pod.members || []).some(
      (m: any) => String(m?._id || m) === String(userId),
    );
    if (!alreadyMember) {
      pod.members.push(userId);
      pod.updatedAt = new Date();
      await pod.save();
    }
    invite.useCount += 1;
    invite.lastUsedAt = new Date();
    await invite.save();
    const updated = await Pod.findById(pod._id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture isBot');
    return res.json({ ok: true, alreadyMember, pod: updated });
  } catch (err: any) {
    console.error('Redeem invite failed:', err.message);
    return res.status(500).json({ msg: err.message || 'Failed to redeem invite' });
  }
});

module.exports = router;
export default router;
