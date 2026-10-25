#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
import mongoose from 'mongoose';

const { hash } = require('../utils/secret');

// A per-row compare-and-set prevents a concurrent rotation or revocation from
// being undone. A conflicting digest is never replaced with a legacy copy.
export const backfillApiTokenStorage = async ({ apply = false }: { apply?: boolean } = {}) => {
  const users = mongoose.connection.collection('users');
  const report = { candidates: 0, migrated: 0, conflicts: 0, skipped: 0, remaining: 0 };
  const cursor = users.find({ apiToken: { $type: 'string' } }, {
    projection: { apiToken: 1, apiTokenHash: 1 },
  });
  try {
    for await (const row of cursor) {
      report.candidates += 1;
      const digest = hash(row.apiToken);
      if (!row.apiToken || (row.apiTokenHash !== undefined && row.apiTokenHash !== digest)) {
        report.conflicts += 1;
        continue;
      }
      if (apply) {
        const result = await users.updateOne({
          _id: row._id,
          apiToken: row.apiToken,
          apiTokenHash: row.apiTokenHash === undefined ? { $exists: false } : row.apiTokenHash,
        }, {
          $set: { apiTokenHash: digest, apiTokenLast4: row.apiToken.slice(-4) },
          $unset: { apiToken: '' },
        });
        if (result.modifiedCount) report.migrated += 1;
        else report.skipped += 1;
      }
    }
  } finally {
    await cursor.close();
  }
  report.remaining = await users.countDocuments({ apiToken: { $exists: true } });
  return report;
};

export const main = async () => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || !process.env.MONGO_URI) {
    throw new Error('invalid configuration');
  }
  const apply = args.includes('--apply');
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const report = await backfillApiTokenStorage({ apply });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY-RUN', ...report }));
    if (report.conflicts || report.skipped || (apply && report.remaining)) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch(() => {
    console.error('[api-token-storage] Failed. No values logged; rerun dry-run to inspect counts.');
    process.exitCode = 1;
  });
}
