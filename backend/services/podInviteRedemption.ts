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

// Waits between give-back tries: three tries, about a second in all.
const GIVE_BACK_RETRY_DELAYS_MS = [250, 750];

// Hands a counted use back after a join that failed. A lost give-back leaves
// the use counted with no member behind it, and a one-use invite would then
// refuse forever, so it retries; if every try fails, one line names the ids an
// operator needs to restore the count.
const giveBackUse = async (inviteId: unknown, podId: unknown): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await PodInvite.updateOne({ _id: inviteId, useCount: { $gt: 0 } }, { $inc: { useCount: -1 } });
      return;
    } catch (error) {
      const delay = GIVE_BACK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error(
          `[pod-invite] give-back failed after ${attempt + 1} tries; invite ${String(inviteId)}`
          + ` (pod ${String(podId)}) has one use too many counted: ${(error as Error)?.name}`,
        );
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, delay); });
    }
  }
};

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
  // A member opening the link joins nothing, so it spends no use: a one-use
  // link a member clicks stays open for the person it was meant for. An
  // unusable invite has already refused above, members included.
  if (alreadyMember) return { ok: true, pod, alreadyMember: true };
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
  // F604: add the member with one conditional update, so the same person
  // redeeming twice at once (a double-click, two tabs), or joining another way
  // meanwhile, lands in `members` once. The loser of that race was already a
  // member by the time it wrote: it gives its use back and reports so. Pod's
  // save hook only acts on a new pod, so skipping save() skips nothing.
  // A pod deleted since the lookup matches nothing too; that refuses as the
  // lookup would have.
  let joined = false;
  try {
    const added = await Pod.updateOne(
      { _id: pod._id, members: { $ne: userId } },
      { $push: { members: userId }, $set: { updatedAt: new Date() } },
    );
    joined = added.modifiedCount > 0;
  } catch (joinError) {
    await giveBackUse(invite._id, pod._id);
    throw joinError;
  }
  if (!joined) {
    await giveBackUse(invite._id, pod._id);
    if (!(await Pod.exists({ _id: pod._id }))) {
      return { ok: false, status: 404, body: { msg: 'Pod no longer exists' } };
    }
  }
  // Callers read the pod as joined, so the returned doc includes the person.
  pod.members.push(userId);
  if (joined) {
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
  return { ok: true, pod, alreadyMember: !joined };
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
