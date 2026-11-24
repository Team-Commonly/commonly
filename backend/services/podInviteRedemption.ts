// Redeeming a pod invite token: the one place that turns a token into pod
// membership. Two callers share it, so they apply the same checks:
//   - POST /api/invites/:token/redeem (routes/podInvites.ts), a signed-in user;
//   - email verification (authController.verifyEmail), for an account that
//     signed up from a pod invite on a team-gated instance (F577): that person
//     cannot sign in until the mailbox is verified, so the invite is carried on
//     the account and redeemed here when the emailed link is clicked.
//
// Bypasses the pod's invite-only joinPolicy because the token IS the invite.
// Unusable tokens (revoked, expired, used up) and personal DM pods refuse.
import User from '../models/User';
import { assertInstalledAgentMayJoinPod } from './outsiderGrantAgentJoinPolicy';

const Pod = require('../models/Pod');
const { PodInvite } = require('../models/PodInvite');
const { HUMAN_FILTER, internalAccountExclusion } = require('./userClassification');

// Pod invite tokens are 16 random bytes in hex (routes/podInvites.ts).
export const POD_INVITE_TOKEN = /^[a-f0-9]{32}$/;

// The query form of PodInvite.isUsable(): not revoked, not expired, and a use
// left (maxUses null means unlimited; 0 means none, as isUsable() reads it).
const usableInviteFilter = (now: Date) => ({
  revokedAt: null,
  $and: [
    { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
    { $or: [{ maxUses: null }, { $expr: { $lt: ['$useCount', '$maxUses'] } }] },
  ],
});

export type PodInviteRedemption =
  | { ok: true; pod: any; alreadyMember: boolean }
  | { ok: false; status: number; body: Record<string, unknown> };

export const redeemPodInvite = async (token: unknown, userId: unknown): Promise<PodInviteRedemption> => {
  const invite = typeof token === 'string' ? await PodInvite.findOne({ token }) : null;
  if (!invite || !invite.isUsable()) {
    return { ok: false, status: 404, body: { msg: 'Invite invalid or expired' } };
  }
  const pod = await Pod.findById(invite.podId);
  if (!pod) return { ok: false, status: 404, body: { msg: 'Pod no longer exists' } };
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { DM_POD_TYPES_GUARD } = require('./agentIdentityService');
  if (DM_POD_TYPES_GUARD.has(String(pod.type))) {
    return {
      ok: false,
      status: 403,
      body: {
        code: 'dm_membership_refused',
        msg: 'DM pods are 1:1 — invite links cannot grant third-party access. Start a new DM instead.',
      },
    };
  }
  const alreadyMember = (pod.members || []).some(
    (m: any) => String(m?._id || m) === String(userId),
  );
  if (!alreadyMember) {
    const joiningUser = await User.findById(userId).select('isBot botType botMetadata').lean();
    if (joiningUser?.isBot || joiningUser?.botType) {
      try {
        await assertInstalledAgentMayJoinPod(
          pod._id, joiningUser.botMetadata?.agentName, joiningUser.botMetadata?.instanceId,
        );
      } catch (joinError: any) {
        if (joinError?.code === 'outsider_grant_non_native_agent_join') {
          return { ok: false, status: 403, body: { code: joinError.code, message: joinError.message } };
        }
        throw joinError;
      }
    }
  }
  // F603: count the use before granting membership, as one conditional update
  // on a still-usable invite. Two redemptions at once can both pass the
  // isUsable() read above; only as many as maxUses has room for match here,
  // and the rest refuse exactly as a used-up invite does. Counting first means
  // a refused claim never leaves an uncounted member behind; a failed join
  // gives its use back.
  const claimed = await PodInvite.updateOne(
    { _id: invite._id, ...usableInviteFilter(new Date()) },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
  );
  if (!claimed.modifiedCount) {
    return { ok: false, status: 404, body: { msg: 'Invite invalid or expired' } };
  }
  if (!alreadyMember) {
    try {
      pod.members.push(userId);
      pod.updatedAt = new Date();
      await pod.save();
    } catch (joinError) {
      await PodInvite.updateOne({ _id: invite._id, useCount: { $gt: 0 } }, { $inc: { useCount: -1 } })
        .catch(() => undefined);
      throw joinError;
    }
    // F183: best-effort PG mirror write; never fails the redemption.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    await require('./pgMirrorWrite').mirrorMemberAdded(String(pod._id), String(userId));
    // A token use by its author, an existing member, a bot or an internal
    // account is not the outside team's second-person conversion.
    if (String(invite.createdBy) !== String(userId)) {
      try {
        const outsidePerson = await User.exists({
          _id: userId, ...HUMAN_FILTER, ...internalAccountExclusion(),
        });
        if (outsidePerson) await PodInvite.updateOne({
          _id: invite._id, firstTeammateJoinedAt: { $exists: false },
        }, { $set: { firstTeammateJoinedAt: new Date() } });
      } catch (error) {
        // Membership has already been committed. Telemetry cannot undo a
        // successful join or turn it into a misleading client error.
        console.warn('[invite-funnel] conversion write failed:', (error as Error).message);
      }
    }
  }
  return { ok: true, pod, alreadyMember };
};

// Whether a token would redeem for someone right now, without using it.
export const isPodInviteRedeemable = async (token: unknown): Promise<boolean> => {
  if (typeof token !== 'string' || !POD_INVITE_TOKEN.test(token)) return false;
  const invite = await PodInvite.findOne({ token });
  if (!invite || !invite.isUsable()) return false;
  const pod = await Pod.findById(invite.podId).select('type').lean();
  if (!pod) return false;
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { DM_POD_TYPES_GUARD } = require('./agentIdentityService');
  return !DM_POD_TYPES_GUARD.has(String(pod.type));
};
