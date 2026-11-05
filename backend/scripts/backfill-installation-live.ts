#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * Stamp the derived `live` flag onto every InstallableInstallation row.
 *
 * The live-target unique index moved from a `status: {$in: [...]}` partial
 * filter (which FerretDB refuses) to `live: true`
 * (`installable_live_target_unique_v2`). The model's hooks derive `live` on
 * every write from the deploy on; rows written before it carry no flag, so the
 * v2 index does not yet cover them. This script closes that gap.
 *
 *   npm run backfill:installation-live                       # dry run: counts only
 *   npm run backfill:installation-live -- --apply            # write
 *   npm run backfill:installation-live -- --verify           # check only
 *   npm run backfill:installation-live -- --apply --verify   # write, then check
 *
 * WHEN TO RUN --apply: only after the rollout has FULLY finished, with no
 * pre-deploy pod left serving. A new pod being up is not enough. Until the
 * last old pod is gone, an old pod can still write `status: 'uninstalled'`
 * without touching `live`, leaving a row the hooks stamped `live: true` while
 * its status is no longer live. A reinstall on that target then hits the v2
 * index's E11000, finds no live winner by status, and returns 500. The
 * SHOULD_NOT_BE_LIVE pass below repairs exactly those rows, which is why the
 * apply has to come after the last old writer is gone. If in doubt, re-run
 * --apply --verify; it is idempotent.
 *
 * --verify is the gate for removing the legacy `installable_live_target_unique`
 * index, so it proves both halves: (1) no row's `live` disagrees with its
 * status, and (2) the replacement index exists, unique, with
 * `partialFilterExpression: { live: true }`. It exits 0 only when both hold.
 *
 * Idempotent: each write targets only rows whose flag disagrees with their
 * status, so a re-run writes nothing. Plain $set updates (no pipeline), which
 * every supported server accepts. The legacy index already guarantees at most
 * one live row per target, so setting `live: true` cannot collide on v2.
 */

import mongoose from 'mongoose';
import InstallableInstallation, { LIVE_INSTALLATION_STATUSES } from '../models/InstallableInstallation';

export const V2_INDEX_NAME = 'installable_live_target_unique_v2';
const V2_INDEX_KEY = { installableId: 1, targetType: 1, targetId: 1 };

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

export interface LiveVerifyResult extends LiveBackfillCounts {
  mismatched: number;
  v2Index: 'ok' | 'missing' | 'wrong-shape';
  ok: boolean;
}

export const countLiveMismatches = async (): Promise<LiveBackfillCounts> => {
  const [scanned, wrongShouldBeLive, wrongShouldNotBeLive] = await Promise.all([
    InstallableInstallation.countDocuments({}),
    InstallableInstallation.countDocuments(SHOULD_BE_LIVE),
    InstallableInstallation.countDocuments(SHOULD_NOT_BE_LIVE),
  ]);
  return { scanned, wrongShouldBeLive, wrongShouldNotBeLive };
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const checkV2Index = async (): Promise<LiveVerifyResult['v2Index']> => {
  let indexes: Array<{ name?: string; unique?: boolean; key?: unknown; partialFilterExpression?: unknown }>;
  try {
    indexes = await InstallableInstallation.collection.indexes();
  } catch (error) {
    // No collection yet means no index.
    if ((error as { codeName?: string; code?: number }).codeName === 'NamespaceNotFound'
      || (error as { code?: number }).code === 26) return 'missing';
    throw error;
  }
  const v2 = indexes.find((index) => index.name === V2_INDEX_NAME);
  if (!v2) return 'missing';
  const shapeOk = v2.unique === true
    && sameJson(v2.key, V2_INDEX_KEY)
    && sameJson(v2.partialFilterExpression, { live: true });
  return shapeOk ? 'ok' : 'wrong-shape';
};

export const verifyInstallationLive = async (): Promise<LiveVerifyResult> => {
  const [counts, v2Index] = await Promise.all([countLiveMismatches(), checkV2Index()]);
  const mismatched = counts.wrongShouldBeLive + counts.wrongShouldNotBeLive;
  return { ...counts, mismatched, v2Index, ok: mismatched === 0 && v2Index === 'ok' };
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

const printVerify = (result: LiveVerifyResult): void => {
  console.log(`installations scanned:        ${result.scanned}`);
  console.log(`live disagrees with status:   ${result.mismatched}`);
  console.log(`  live status, live != true:   ${result.wrongShouldBeLive}`);
  console.log(`  other status, live != false: ${result.wrongShouldNotBeLive}`);
  console.log(`${V2_INDEX_NAME}: ${result.v2Index}`);
  if (result.ok) {
    console.log('VERIFY OK');
    return;
  }
  const reasons = [
    result.mismatched > 0 ? 'rows disagree (run --apply)' : '',
    result.v2Index !== 'ok' ? `v2 index ${result.v2Index} (boot the new code or syncIndexes first)` : '',
  ].filter(Boolean);
  console.log(`VERIFY FAILED: ${reasons.join('; ')}`);
};

/**
 * The work on an already-open connection. Returns the exit code: 0 on
 * success, 2 when --verify fails. With both flags, the apply runs first and
 * the verify then checks its result; neither flag is ignored.
 */
export async function run(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify');
  if (apply || !verify) {
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
  }
  if (!verify) return 0;
  const result = await verifyInstallationLive();
  printVerify(result);
  return result.ok ? 0 : 2;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    return 1;
  }
  // No index builds on connect: a backfill or verify run must not change the
  // index set, or --verify would find a v2 index this run just made.
  mongoose.set('autoIndex', false);
  await mongoose.connect(mongoUri);
  try {
    return await run(argv);
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
