#!/usr/bin/env node
/*
 * Re-encrypt ConnectorSecret rows under CONNECTOR_SECRET_ACTIVE_KEY.
 *
 * Rotation is intentionally two-phase: deploy a ring containing old + new,
 * point CONNECTOR_SECRET_ACTIVE_KEY at new, run this script until it reports
 * zero remaining rows, then remove the old key. It is idempotent: rewrap()
 * leaves rows already under the active key untouched.
 *
 * Usage:
 *   npx ts-node backend/scripts/rewrap-connector-secrets.ts          # dry run
 *   npx ts-node backend/scripts/rewrap-connector-secrets.ts --apply
 */

/* eslint-disable no-console */
const mongoose = require('mongoose');
const ConnectorSecret = require('../models/ConnectorSecret');
const { rewrap } = require('../services/connectorSecrets');

const APPLY = process.argv.includes('--apply');

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (!process.env.CONNECTOR_SECRET_ACTIVE_KEY) {
    throw new Error('CONNECTOR_SECRET_ACTIVE_KEY is required');
  }
  await mongoose.connect(process.env.MONGO_URI);
  const activeKeyId = process.env.CONNECTOR_SECRET_ACTIVE_KEY;
  const rows = await ConnectorSecret.find({ keyId: { $ne: activeKeyId } }).select('_id keyId integrationId').lean();
  console.log(`connector secrets needing rewrap: ${rows.length}`);
  rows.slice(0, 20).forEach((row: any) => {
    console.log(`  ${row._id} key=${row.keyId} integration=${row.integrationId}`);
  });
  if (!APPLY) {
    console.log('DRY RUN — re-run with --apply to re-encrypt.');
    await mongoose.disconnect();
    return;
  }
  let rewritten = 0;
  for (const row of rows) {
    // The module decrypts with the row's key id and encrypts with the active
    // key; the row-level CAS inside it makes a concurrent rerun harmless.
    // eslint-disable-next-line no-await-in-loop
    await rewrap(String(row._id));
    rewritten += 1;
  }
  const remaining = await ConnectorSecret.countDocuments({ keyId: { $ne: activeKeyId } });
  console.log(`rewrapped ${rewritten}; remaining under non-active keys: ${remaining}`);
  await mongoose.disconnect();
};

main().catch((error) => {
  console.error('[rewrap-connector-secrets] failed:', error.message);
  process.exit(1);
});
