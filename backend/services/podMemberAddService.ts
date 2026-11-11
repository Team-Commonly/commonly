// A pod's creator adds a person who is already on the instance, by username.
// Before this, only an invite link could, and the invitee had to open it.
//
// An invite carries the invitee's own act of joining. A direct add doesn't, so
// it is limited to someone the creator already works with: a person who shares
// another pod with the creator that isn't a public community pod (everyone is
// auto-joined to those). Anyone else still gets an invite link. An unknown
// username, a banned account and a person the creator shares no pod with get
// the same answer, so the route can't be used to find out who has an account.
//
// Otherwise the checks are the invite redeem's: no third person in a 1:1 DM
// pod, and an add is idempotent. Agents join a pod by being installed, never
// through this.
import mongoose from 'mongoose';
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { DM_POD_TYPES_GUARD } = require('./agentIdentityService');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { mirrorMemberAdded } = require('./pgMirrorWrite');

export type AddMemberRefusal =
  | 'pod_not_found'
  | 'not_pod_creator'
  | 'dm_membership_refused'
  | 'username_required'
  | 'agent_not_addable'
  | 'teammate_not_found';

export type AddMemberResult =
  | { refusal: AddMemberRefusal }
  | { refusal?: undefined; alreadyMember: boolean; member: { _id: string; username: string } };

const USERNAME_MAX = 64;

const memberId = (m: unknown): string => String((m as { _id?: unknown })?._id || m);

export const addPodMemberByUsername = async (
  { podId, callerId, username }: { podId: string; callerId: string; username: unknown },
): Promise<AddMemberResult> => {
  const pod = await Pod.findById(podId).select('_id type createdBy members').lean();
  if (!pod) return { refusal: 'pod_not_found' };
  if (memberId(pod.createdBy) !== callerId) return { refusal: 'not_pod_creator' };
  if (DM_POD_TYPES_GUARD.has(String(pod.type))) return { refusal: 'dm_membership_refused' };

  const name = typeof username === 'string' ? username.trim().replace(/^@/, '') : '';
  if (!name || name.length > USERNAME_MAX) return { refusal: 'username_required' };

  const target = await User.findOne({ username: name })
    .select('_id username isBot botType botMetadata.agentName banned')
    .lean();
  if (!target || target.banned === true) return { refusal: 'teammate_not_found' };
  if (target.isBot || target.botType || target.botMetadata?.agentName) return { refusal: 'agent_not_addable' };

  const targetId = String(target._id);
  const member = { _id: targetId, username: String(target.username) };
  if ((pod.members || []).some((m: unknown) => memberId(m) === targetId)) {
    return { alreadyMember: true, member };
  }

  const sharesAPod = await Pod.exists({
    _id: { $ne: pod._id },
    members: { $all: [new mongoose.Types.ObjectId(callerId), target._id] },
    publicRead: { $ne: true },
    type: { $nin: [...DM_POD_TYPES_GUARD] },
  });
  if (!sharesAPod) return { refusal: 'teammate_not_found' };

  await Pod.updateOne(
    { _id: pod._id },
    { $addToSet: { members: target._id }, $set: { updatedAt: new Date() } },
  );
  // Best-effort, as on every other join path: a failure is logged inside.
  await mirrorMemberAdded(String(pod._id), targetId);
  return { alreadyMember: false, member };
};
