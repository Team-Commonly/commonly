#!/usr/bin/env node

import mongoose from 'mongoose';
import Pod from '../models/Pod';
import { getCommunityPodId } from '../services/communityPodService';

const COMMUNITY_POD_SEEDS = [
  {
    name: 'Bug Reports',
    description: 'Report bugs, share reproduction details, and follow fixes.',
  },
  {
    name: 'Feature Requests',
    description: 'Suggest improvements and discuss ideas for Commonly.',
  },
] as const;

export interface SeedCommunityPodsResult {
  apply: boolean;
  total: number;
  existing: number;
  wouldCreate: number;
  created: number;
  updated: number;
}

/**
 * Seed the two open, listed feedback Pods beneath Commonly HQ.
 * Dry-run is the default; callers must opt into mutation with `apply: true`.
 */
export async function seedCommunityPods(
  options: { apply?: boolean } = {},
): Promise<SeedCommunityPodsResult> {
  const apply = options.apply === true;
  const communityPodId = getCommunityPodId();
  if (!communityPodId) {
    throw new Error('COMMUNITY_POD_ID is required.');
  }

  const hq = await Pod.findById(communityPodId).select('_id createdBy').lean();
  if (!hq) {
    throw new Error('Configured COMMUNITY_POD_ID Pod was not found.');
  }

  const existingPods = await Pod.find({
    parentPod: hq._id,
    name: { $in: COMMUNITY_POD_SEEDS.map((seed) => seed.name) },
  }).select('name').lean();
  const existingNames = new Set(existingPods.map((pod) => pod.name));
  const result: SeedCommunityPodsResult = {
    apply,
    total: COMMUNITY_POD_SEEDS.length,
    existing: existingNames.size,
    wouldCreate: COMMUNITY_POD_SEEDS.length - existingNames.size,
    created: 0,
    updated: 0,
  };

  if (!apply) return result;

  for (const seed of COMMUNITY_POD_SEEDS) {
    const write = await Pod.updateOne(
      { name: seed.name, parentPod: hq._id },
      {
        $setOnInsert: {
          description: seed.description,
          type: 'team',
          joinPolicy: 'open',
          publicRead: true,
          communityListed: true,
          createdBy: hq.createdBy,
          members: [hq.createdBy],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, timestamps: false },
    );

    result.created += write.upsertedCount || 0;
    result.updated += write.modifiedCount || 0;

    if (process.env.PG_HOST && write.upsertedId) {
      try {
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const PGPod = require('../models/pg/Pod');
        await PGPod.create(
          seed.name,
          seed.description,
          'team',
          String(hq.createdBy),
          String(write.upsertedId),
        );
      } catch (err) {
        // Mongo is authoritative; lazy PG sync can repair a failed mirror.
        console.warn('[community-pod-seed] PostgreSQL mirror failed:', (err as Error).message);
      }
    }
  }

  return result;
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
      const result = await seedCommunityPods({ apply });
      console.log(
        `Community Pod seed ${apply ? '(apply)' : '(dry-run)'} `
        + `total=${result.total} existing=${result.existing} `
        + `wouldCreate=${result.wouldCreate} created=${result.created} updated=${result.updated}`,
      );
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
