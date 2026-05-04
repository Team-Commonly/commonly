// Pod invite tokens — shareable URLs that let a logged-in user join a pod
// without going through the invite-only joinPolicy gate. Tokens are random
// (16-byte hex), DB-backed (PodInvite), and bound to a single pod by their
// creator. Logged-in users only — no guest registration via invite.
import express from 'express';
import crypto from 'crypto';
const router = express.Router();
const auth = require('../middleware/auth');
const Pod = require('../models/Pod');
const { PodInvite } = require('../models/PodInvite');

const getUserId = (req: any) => req.userId || req.user?.id || req.user?._id;

const isPodMember = (pod: any, userId: string) => {
  if (!pod || !userId) return false;
  if (pod.createdBy?.toString?.() === userId.toString()) return true;
  return (pod.members || []).some((m: any) => (
    (m?._id?.toString?.() || m?.toString?.() || '') === userId.toString()
  ));
};

// POST /api/pods/:podId/invites — issue a fresh invite token. Caller must
// be a member or creator. Body: { expiresInHours?, maxUses? } — both
// optional; null = unlimited.
router.post('/pods/:podId/invites', auth, async (req: any, res: any) => {
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

// GET /api/invites/:token — resolve token to public pod info. Auth required
// (we don't reveal pod existence to anonymous callers).
router.get('/invites/:token', auth, async (req: any, res: any) => {
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
// the token IS the invite. DM pods (agent-room/agent-dm/agent-admin) are
// strictly 1:1 and refuse — start a fresh DM instead, same rule as joinPod.
router.post('/invites/:token/redeem', auth, async (req: any, res: any) => {
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
