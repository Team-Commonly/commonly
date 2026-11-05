#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * Stamp the derived `live` flag onto every InstallableInstallation row.
 *
 * The live-target unique index moved from a `status: {$in: [...]}` partial
 * filter (which FerretDB refuses) to `live: true`
 * (`installable_live_target_unique_v2`). The model's hooks derive `live` on
 * every write from now on; rows written before that deploy carry no flag, so
 * the v2 index does not yet cover them. This script closes that gap.
 *
 *   npm run backfill:installation-live              # dry run: counts only
 *   npm run backfill:installation-live -- --apply   # write
 *   npm run backfill:installation-live -- --verify  # count rows where live disagrees with status
 *
 * --verify exits non-zero unless the count is 0. It must report 0 on prod
 * before the legacy `installable_live_target_unique` index is removed.
 *
 * Idempotent: each write targets only rows whose flag disagrees with their
 * status, so a re-run writes nothing. Uses plain $set updates (no pipeline),
 * which every supported server accepts. The legacy index already guarantees
 * at most one live row per target, so setting `live: true` cannot collide on
 * the v2 index.
 */

import mongoose from 'mongoose';
import InstallableInstallation, { LIVE_INSTALLATION_STATUSES } from '../models/InstallableInstallation';

// No index builds on connect: a backfill run must not change the index set.
mongoose.set('autoIndex', false);

const LIVE = [...LIVE_INSTALLATION_STATUSES];

// A missing status matches $nin, and a missing status is not live: the same
// answer the model's pipeline-update hook gives.
const SHOULD_BE_LIVE = { status: { $in: LIVE }, live: { $ne: true } };
const SHOULD_NOT_BE_LIVE = { status: { $nin: LIVE }, live: { $ne: false } };

export interface LiveBackfillCounts {
  scanned: number;
  wrongShouldBeLive: number;
  wrongShouldNotBeLive: number;
}

export interface LiveBackfillResult extends LiveBackfillCounts {
  apply: boolean;
  setLive: number;
  setNotLive: number;
}

export const countLiveMismatches = async (): Promise<LiveBackfillCounts> => {
  const [scanned, wrongShouldBeLive, wrongShouldNotBeLive] = await Promise.all([
    InstallableInstallation.countDocuments({}),
    InstallableInstallation.countDocuments(SHOULD_BE_LIVE),
    InstallableInstallation.countDocuments(SHOULD_NOT_BE_LIVE),
  ]);
  return { scanned, wrongShouldBeLive, wrongShouldNotBeLive };
};

export const backfillInstallationLive = async (
  { apply }: { apply: boolean },
): Promise<LiveBackfillResult> => {
  const counts = await countLiveMismatches();
  if (!apply) return { ...counts, apply, setLive: 0, setNotLive: 0 };
  // Raw collection writes: the update touches only `live`, so the model hook
  // would add nothing, and the count must be what the server changed.
  const live = await InstallableInstallation.collection.updateMany(SHOULD_BE_LIVE, { $set: { live: true } });
  const notLive = await InstallableInstallation.collection.updateMany(SHOULD_NOT_BE_LIVE, { $set: { live: false } });
  return {
    ...counts,
    apply,
    setLive: live.modifiedCount ?? 0,
    setNotLive: notLive.modifiedCount ?? 0,
  };
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    return 1;
  }
  await mongoose.connect(mongoUri);
  try {
    if (verify) {
      const counts = await countLiveMismatches();
      const mismatched = counts.wrongShouldBeLive + counts.wrongShouldNotBeLive;
      console.log(`installations scanned:        ${counts.scanned}`);
      console.log(`live disagrees with status:   ${mismatched}`);
      console.log(`  live status, live != true:   ${counts.wrongShouldBeLive}`);
      console.log(`  other status, live != false: ${counts.wrongShouldNotBeLive}`);
      console.log(mismatched === 0 ? 'VERIFY OK' : 'VERIFY FAILED: run with --apply');
      return mismatched === 0 ? 0 : 2;
    }
    const result = await backfillInstallationLive({ apply });
    console.log(`installations scanned:        ${result.scanned}`);
    console.log(`to set live: true:            ${result.wrongShouldBeLive}`);
    console.log(`to set live: false:           ${result.wrongShouldNotBeLive}`);
    if (apply) {
      console.log(`set live: true:               ${result.setLive}`);
      console.log(`set live: false:              ${result.setNotLive}`);
    } else {
      console.log('DRY RUN — pass --apply to write, then --verify.');
    }
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
