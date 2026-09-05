#!/usr/bin/env node
/*
 * D8 Phase 2 connector-gate migration.
 *
 * Converts only installable-backed connector projections to user scope. A
 * legacy integration has no installationId and remains pod scoped. The CAS
 * filter makes a second run a no-op, including if a live writer creates a
 * gate between this script's read and write.
 *
 * Usage:
 *   ts-node backend/scripts/migrate-connector-gates.ts --dry
 *   ts-node backend/scripts/migrate-connector-gates.ts
 */

import mongoose from 'mongoose';
import Integration from '../models/Integration';
import InstallableInstallation from '../models/InstallableInstallation';

export interface ConnectorGateMigrationResult {
  scanned: number;
  migrated: number;
  skipped: number;
}

export async function migrateConnectorGates(
  options: { dryRun?: boolean } = {},
): Promise<ConnectorGateMigrationResult> {
  const dryRun = options.dryRun === true;
  const result: ConnectorGateMigrationResult = { scanned: 0, migrated: 0, skipped: 0 };
  const cursor = Integration.find({
    installationId: { $exists: true, $type: 'string' },
    podId: { $exists: true, $ne: null },
    'config.gates': { $exists: false },
  }).select('_id podId createdAt').cursor();

  for await (const integration of cursor) {
    result.scanned += 1;
    const podId = String(integration.podId || '');
    if (!podId) {
      result.skipped += 1;
      continue;
    }
    if (dryRun) {
      result.migrated += 1;
      continue;
    }
    const updated = await Integration.updateOne(
      {
        _id: integration._id,
        installationId: { $exists: true, $type: 'string' },
        podId: integration.podId,
        'config.gates': { $exists: false },
      },
      {
        $set: {
          scope: 'user',
          [`config.gates.${podId}`]: {
            enabled: true,
            since: integration.createdAt || new Date(),
          },
        },
      },
    );
    if (updated.modifiedCount) result.migrated += 1;
    else result.skipped += 1;
  }
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
    // The partial unique index's live set gained paused in this schema flip.
    // A dry run remains fully read-only.
    if (!dryRun) await InstallableInstallation.syncIndexes();
    const result = await migrateConnectorGates({ dryRun });
    console.log(
      `[migrate-connector-gates] ${dryRun ? 'DRY-RUN ' : ''}`
      + `scanned=${result.scanned} migrated=${result.migrated} skipped=${result.skipped}`,
    );
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
