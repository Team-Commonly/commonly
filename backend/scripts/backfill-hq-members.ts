#!/usr/bin/env node

import mongoose from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';
import { getCommunityPodId } from '../services/communityPodService';

export interface BackfillHqMembersResult {
  configured: boolean;
  podFound: boolean;
  apply: boolean;
  totalVerifiedHumans: number;
  alreadyMembers: number;
  wouldAdd: number;
}

const emptyResult = (apply: boolean): BackfillHqMembersResult => ({
  configured: false,
  podFound: false,
  apply,
  totalVerifiedHumans: 0,
  alreadyMembers: 0,
  wouldAdd: 0,
});

/**
 * Backfill verified human users into the configured community Pod.
 * Dry-run is the default; callers must opt into mutation with `apply: true`.
 */
export async function backfillHqMembers(
  options: { apply?: boolean } = {},
): Promise<BackfillHqMembersResult> {
  const apply = options.apply === true;
  const podId = getCommunityPodId();
  if (!podId) {
    console.warn('[community-pod-backfill] COMMUNITY_POD_ID is unset; nothing to do.');
    return emptyResult(apply);
  }

  const result = { ...emptyResult(apply), configured: true };

  try {
    const [users, pod] = await Promise.all([
      User.find({ verified: true, isBot: { $ne: true } }).select('_id').lean(),
      Pod.findById(podId).select('members').lean(),
    ]);

    result.totalVerifiedHumans = users.length;
    if (!pod) {
      console.warn('[community-pod-backfill] configured Pod was not found; nothing to do.');
      return result;
    }
    result.podFound = true;

    const existingMembers = new Set((pod.members || []).map((memberId) => String(memberId)));
    const userIds = users.map((user) => user._id);
    result.alreadyMembers = userIds.filter((userId) => existingMembers.has(String(userId))).length;
    result.wouldAdd = result.totalVerifiedHumans - result.alreadyMembers;

    if (apply && userIds.length > 0) {
      await Pod.updateOne(
        { _id: podId },
        { $addToSet: { members: { $each: userIds } } },
      );
    }
    return result;
  } catch (err) {
    console.warn('[community-pod-backfill] failed open:', (err as Error).message);
    return result;
  }
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required.');
    process.exit(1);
  }

  (async () => {
    await mongoose.connect(uri);
    try {
      const result = await backfillHqMembers({ apply });
      console.log(
        `HQ membership backfill ${apply ? '(apply)' : '(dry-run)'} `
        + `totalVerifiedHumans=${result.totalVerifiedHumans} `
        + `alreadyMembers=${result.alreadyMembers} wouldAdd=${result.wouldAdd}`,
      );
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
