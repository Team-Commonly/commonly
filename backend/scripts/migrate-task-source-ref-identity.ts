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
 * Ordering: run this AFTER the new code is deployed, never before. The two
 * orderings are not comparable, because it is the DROP that is load-bearing:
 * the pre-TASK-063 code matches the legacy index by name in its 11000 recovery
 * (routes/tasksApi.ts), so dropping it while that code is still live takes away
 * the only thing that turns a lost create race into an idempotent replay, and a
 * differing-title race then writes a SECOND row for one (podId, sourceRef) that
 * the deployed code resolves arbitrarily. After the deploy the worst case is a
 * named 503 (`task_source_ref_index_migration_pending`) on that narrow case for
 * a bounded window, with nothing written.
 *
 * `migrateTaskSourceRefIdentity` enforces this rather than trusting the reader
 * of a note: it refuses to drop the legacy index until the pair index is
 * visible. The pair index is not a version marker, but its presence does mean
 * pair-aware code has booted against this database.
 *
 * Usage (from backend/):
 *   npm run migrate:task-source-ref-identity -- --dry
 *   npm run migrate:task-source-ref-identity
 *   npm run migrate:task-source-ref-identity -- --force   # drop anyway
 */

import mongoose from 'mongoose';
import Task from '../models/Task';

// This process must not create indexes as a side effect of connecting. Two
// reasons, both about the ordering guard below. Whatever autoIndex creates is
// created by this script rather than by a boot, so it cannot serve as evidence
// about the deploy: measured on a database holding only the legacy index, a DRY
// RUN left `podId_1_status_1` behind, and the declared indexes are created one
// after another — so the pair index is next in the same sequence and any run
// that has not already exited leaves the guard's own evidence behind for its
// next run to pass on. And it makes `--dry` what its own output claims: no
// changes written. `Task.createIndexes()` below is explicit and unaffected.
mongoose.set('autoIndex', false);

const LEGACY_INDEX = 'podId_1_sourceRef_1_partial';
const PAIR_INDEX = 'podId_1_sourceRef_1_title_1_partial';

export interface TaskSourceRefIdentityResult {
  dryRun: boolean;
  legacyIndexPresent: boolean;
  pairIndexPresentBefore: boolean;
  pairIndexPresentAfter: boolean;
  droppedLegacy: boolean;
  // The legacy index was left in place because the pair index it is being
  // replaced by is not visible (or, under --dry, would be left in place).
  // Nothing at all was written in that case — see the guard below for why
  // creating the pair index here would defeat the guard on its next run.
  dropWithheld: boolean;
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
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<TaskSourceRefIdentityResult> {
  const dryRun = options.dryRun === true;
  const names = await indexNames();
  const result: TaskSourceRefIdentityResult = {
    dryRun,
    legacyIndexPresent: names.includes(LEGACY_INDEX),
    pairIndexPresentBefore: names.includes(PAIR_INDEX),
    pairIndexPresentAfter: names.includes(PAIR_INDEX),
    droppedLegacy: false,
    dropWithheld: false,
  };

  // The ordering guard. Dropping the legacy index before the code that replaces
  // it is live takes the deployed code's 11000 backstop away (see the header),
  // so the drop needs evidence that code has booted against THIS database. The
  // pair index is that evidence: models/Task.ts declares it and nothing in
  // backend turns mongoose's autoIndex off (config/db.ts passes only
  // useNewUrlParser / useUnifiedTopology), so a boot creates it — the same
  // reason the test for this script has to DROP it to reproduce an old database.
  //
  // Two properties make fail-closed safe here. It cannot deadlock: pair-aware
  // code boots fine while the legacy index is present — the named 503 IS its
  // designed degraded state — so deploy-then-migrate stays reachable. And the
  // signal is honest about what it is: an index being present proves SOME
  // pair-aware code booted here, not which version, which is enough for the
  // ordering hazard and is not a version check. --force is for an operator who
  // has another reason to believe the deploy is live.
  result.dropWithheld = result.legacyIndexPresent
    && !result.pairIndexPresentBefore
    && options.force !== true;

  // Withholding returns before createIndexes(). Creating the pair index here
  // would make the NEXT run of this script see it, pass the guard, and drop —
  // the guard would authorise itself. Nothing is written while the drop is
  // withheld, and nothing needs to be: the deploy creates the pair index at
  // boot, which is exactly what the guard is waiting for.
  if (dryRun || result.dropWithheld) return result;

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
  const force = process.argv.includes('--force');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  try {
    const result = await migrateTaskSourceRefIdentity({ dryRun, force });
    console.log(
      `[migrate-task-source-ref-identity] ${dryRun ? 'DRY-RUN (no changes written) ' : ''}`
      + `legacyIndexPresent=${result.legacyIndexPresent} `
      + `pairIndexPresentBefore=${result.pairIndexPresentBefore} `
      + `pairIndexPresentAfter=${result.pairIndexPresentAfter} `
      + `droppedLegacy=${result.droppedLegacy} `
      + `dropWithheld=${result.dropWithheld}`,
    );
    if (result.dropWithheld) {
      console.error(
        `[migrate-task-source-ref-identity] ${dryRun ? 'would withhold' : 'WITHHELD'} the drop of `
        + `${LEGACY_INDEX}: ${PAIR_INDEX} is not present, so the code that replaces the legacy index`
        + ' does not appear to have booted against this database yet. Deploy the new code first and'
        + ` re-run; --force drops it anyway, at the cost of the deployed code having no 11000`
        + ' backstop for a differing-title race.',
      );
      if (!dryRun) process.exitCode = 1;
    } else if (!dryRun && !result.pairIndexPresentAfter) {
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
