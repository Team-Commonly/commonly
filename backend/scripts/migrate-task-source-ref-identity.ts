#!/usr/bin/env node
/*
 * TASK-063: replace the sourceRef-only unique index with the
 * (podId, sourceRef, title) pair index that models/Task.ts declares.
 *
 * Why this has to be RUN rather than left to the boot-time autoIndex: mongoose
 * CREATES the indexes a schema declares but never DROPS one it does not know
 * about, and the ref-only index is STRICTER than the pair. While it exists, a
 * second ask that shares a source with an existing task cannot be inserted at
 * all — so the route answers that case with a named 503
 * (`task_source_ref_index_migration_pending`) instead of a silent wrong row,
 * and the gap is loud rather than quiet.
 *
 * Ordering is safe either way: before the deploy it creates an index the
 * deployed code never consults; after the deploy it only shortens the window in
 * which a mismatched-title create is refused.
 *
 * Usage (from backend/):
 *   npm run migrate:task-source-ref-identity -- --dry
 *   npm run migrate:task-source-ref-identity
 */

import mongoose from 'mongoose';
import Task from '../models/Task';

const LEGACY_INDEX = 'podId_1_sourceRef_1_partial';
const PAIR_INDEX = 'podId_1_sourceRef_1_title_1_partial';

export interface TaskSourceRefIdentityResult {
  dryRun: boolean;
  legacyIndexPresent: boolean;
  pairIndexPresentBefore: boolean;
  pairIndexPresentAfter: boolean;
  droppedLegacy: boolean;
}

async function indexNames(): Promise<string[]> {
  try {
    const indexes = await Task.collection.indexes();
    return indexes.map((index) => String(index.name));
  } catch (error) {
    // A database with no `tasks` collection yet has no indexes to report, and
    // mongod answers NamespaceNotFound (code 26) rather than an empty list.
    // Found by the migration's own test, whose first run is on an empty DB.
    if ((error as { code?: number }).code === 26) return [];
    throw error;
  }
}

export async function migrateTaskSourceRefIdentity(
  options: { dryRun?: boolean } = {},
): Promise<TaskSourceRefIdentityResult> {
  const dryRun = options.dryRun === true;
  const names = await indexNames();
  const result: TaskSourceRefIdentityResult = {
    dryRun,
    legacyIndexPresent: names.includes(LEGACY_INDEX),
    pairIndexPresentBefore: names.includes(PAIR_INDEX),
    pairIndexPresentAfter: names.includes(PAIR_INDEX),
    droppedLegacy: false,
  };
  if (dryRun) return result;

  if (result.legacyIndexPresent) {
    await Task.collection.dropIndex(LEGACY_INDEX);
    result.droppedLegacy = true;
  }
  // createIndexes, not syncIndexes: make sure the declared pair index exists
  // without dropping any index this schema does not know about. The pair is a
  // strict relaxation of the ref-only index, so no existing document can
  // violate it.
  await Task.createIndexes();
  result.pairIndexPresentAfter = (await indexNames()).includes(PAIR_INDEX);
  return result;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  try {
    const result = await migrateTaskSourceRefIdentity({ dryRun });
    console.log(
      `[migrate-task-source-ref-identity] ${dryRun ? 'DRY-RUN (no changes written) ' : ''}`
      + `legacyIndexPresent=${result.legacyIndexPresent} `
      + `pairIndexPresentBefore=${result.pairIndexPresentBefore} `
      + `pairIndexPresentAfter=${result.pairIndexPresentAfter} `
      + `droppedLegacy=${result.droppedLegacy}`,
    );
    if (!dryRun && !result.pairIndexPresentAfter) {
      console.error(`[migrate-task-source-ref-identity] ${PAIR_INDEX} is still missing after createIndexes()`);
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
