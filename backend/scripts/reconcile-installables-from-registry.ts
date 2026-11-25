/**
 * reconcile-installables-from-registry — backfill an Installable row for every
 * AgentRegistry row that has none (ADR-001 Phase 3, step 5).
 *
 * Dry run unless `--apply`. Inserts missing rows and refreshes display fields
 * on rows it created (origin 'registry-backfill'), never on any other
 * Installable. Never deletes, never touches User, AgentInstallation,
 * AgentProfile, memory or Pod. Status and install-count drift on existing rows
 * is reported, not fixed. The scheduler runs the same sweep hourly.
 *
 * Run with: `cd backend && MONGO_URI=... node dist/scripts/reconcile-installables-from-registry.js [--apply]`
 */

/* eslint-disable no-console */
import mongoose from 'mongoose';
import { sweepRegistryDrift } from '../services/installable/registryReconciler';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is required');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri);
  try {
    const r = await sweepRegistryDrift({ dryRun: !apply });
    console.log(JSON.stringify(r, null, 2));
    if (!apply) console.log('Dry run: nothing written. Re-run with --apply to insert and refresh.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Reconcile failed:', err);
    process.exit(1);
  });
}
