#!/usr/bin/env node
/*
 * Remove the legacy GitHub metadata from task documents after the task board
 * stopped owning GitHub synchronization. The current Task schema no longer
 * writes or reads these fields, but Mongoose lean queries preserve unknown
 * fields already stored in Mongo, so this one-shot sweep is the compatibility
 * half of the schema removal.
 *
 * Usage:
 *   npx ts-node backend/scripts/remove-task-github-fields.ts
 *   npx ts-node backend/scripts/remove-task-github-fields.ts --apply
 */

/* eslint-disable no-console */
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const LEGACY_FIELDS = [
  'githubIssueNumber',
  'githubIssueUrl',
  'githubIssueOwned',
] as const;

const legacyFieldFilter = {
  $or: LEGACY_FIELDS.map((field) => ({ [field]: { $exists: true } })),
};

const unsetLegacyFields = Object.fromEntries(
  LEGACY_FIELDS.map((field) => [field, '']),
);

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  // Do not route this through Task: these fields are intentionally absent from
  // the current schema, while this migration must still find stored legacy
  // documents by their old keys.
  const tasks = mongoose.connection.collection('tasks');
  const candidates = await tasks.countDocuments(legacyFieldFilter);
  console.log(`legacy task rows: ${candidates}`);

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  const result = await tasks.updateMany(legacyFieldFilter, {
    $unset: unsetLegacyFields,
  });
  console.log(`APPLIED — ${result.modifiedCount} of ${candidates} rows modified.`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('task GitHub field removal failed:', error);
  process.exit(1);
});
