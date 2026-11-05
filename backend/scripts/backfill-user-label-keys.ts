#!/usr/bin/env node
/* eslint-disable no-console */
/*
 * Write `labelKeys` (models/accountLabelKeys.ts) onto users from before it existed.
 *
 * The case-insensitive label checks match folded copies of each user's
 * labels. A user saved or updated since the deploy already carries them; an
 * older one is matched by the checks' regex fallback until this has run. Once
 * --verify reports 0 missing and 0 stale, a follow-up drops that fallback.
 *
 *   npm run backfill:user-label-keys                     # dry run: counts only
 *   npm run backfill:user-label-keys -- --apply          # writes the keys
 *   npm run backfill:user-label-keys -- --verify         # missing + stale counts; exit 1 unless both are 0
 *   npm run backfill:user-label-keys -- --apply --verify # writes, then re-scans and verifies the fresh counts
 *
 * Run --apply only after the rollout has FULLY finished, when no pod from
 * before the plugin is still serving. An old pod writes labels without keys,
 * or with the old lowercase-only keys, during the rollout; --apply repairs
 * those stale keys along with the never-written ones, but only once nothing
 * old can write after it.
 *
 * Re-running is a no-op. Each write is compare-and-set on the labels the keys
 * were computed from, so a label renamed between the read and the write is left
 * for the next run (or was already keyed by the rename itself). Keys are
 * computed in JS with the same function the plugin uses: Mongo's $toLower is
 * ASCII-only and does no Unicode normalization, and a non-ASCII display name
 * must key the same either way.
 *
 * Run through the throwaway read pod or ops-runner, never the serving backend.
 */
import mongoose from 'mongoose';
import { labelKeysFor } from '../models/accountLabelKeys';

mongoose.set('autoIndex', false);

const BATCH = 500;
const LABEL_FIELDS = { username: 1, previousUsernames: 1, displayName: 1, 'botMetadata.displayName': 1, labelKeys: 1 };

type Row = Record<string, any>;

const sameKeys = (a: Row | undefined, b: Row): boolean => Boolean(a)
  && a!.username === b.username && a!.displayName === b.displayName && a!.botDisplayName === b.botDisplayName
  && JSON.stringify(a!.previousUsernames || []) === JSON.stringify(b.previousUsernames);

export async function backfillUserLabelKeys(
  { apply = false }: { apply?: boolean } = {},
): Promise<{ scanned: number; missing: number; stale: number; written: number; raced: number }> {
  const users = mongoose.connection.collection('users');
  const counts = { scanned: 0, missing: 0, stale: 0, written: 0, raced: 0 };
  let after: any = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- paged by _id
    const rows = await users.find(after ? { _id: { $gt: after } } : {}, { projection: LABEL_FIELDS })
      .sort({ _id: 1 }).limit(BATCH).toArray() as Row[];
    if (!rows.length) break;
    for (const row of rows) {
      counts.scanned += 1;
      const keys = labelKeysFor(row);
      if (sameKeys(row.labelKeys, keys)) continue; // eslint-disable-line no-continue
      if (row.labelKeys) counts.stale += 1; else counts.missing += 1;
      if (!apply) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const result = await users.updateOne(<Row>{
        _id: row._id,
        username: row.username,
        displayName: row.displayName ?? null,
        'botMetadata.displayName': row.botMetadata?.displayName ?? null,
        previousUsernames: row.previousUsernames ?? null,
      }, { $set: { labelKeys: keys } });
      if (result.modifiedCount) counts.written += 1; else counts.raced += 1;
    }
    after = rows[rows.length - 1]._id;
  }
  return counts;
}

/**
 * The CLI's modes on an open connection. With --apply and --verify together the
 * first scan's counts are what it found BEFORE writing, so verify re-scans
 * read-only and decides on what is stored now. Returns the exit code.
 */
export async function runBackfillCli(
  argv: string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  const apply = argv.includes('--apply');
  const verify = argv.includes('--verify');
  let counts = await backfillUserLabelKeys({ apply });
  log(JSON.stringify({ mode: apply ? 'apply' : (verify ? 'verify' : 'dry-run'), ...counts }));
  if (verify && apply) {
    counts = await backfillUserLabelKeys();
    log(JSON.stringify({ mode: 'verify', ...counts }));
  }
  return verify && (counts.missing || counts.stale) ? 1 : 0;
}

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI as string);
    const exitCode = await runBackfillCli(process.argv);
    await mongoose.disconnect();
    if (exitCode) process.exit(exitCode);
  })().catch((error) => {
    console.error('[backfill-user-label-keys] failed:', error.message);
    process.exit(1);
  });
}
