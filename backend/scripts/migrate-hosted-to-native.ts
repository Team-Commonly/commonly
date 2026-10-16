#!/usr/bin/env node
/*
 * Move every active hosted install from the Durable Object onto the native
 * engine (TASK-265). The rules live in services/hostedEngineMigration.ts.
 * Dry run by default; `--apply` changes rows.
 *
 * Usage (inside the backend pod, where MONGO_URI and the hosted worker env are set):
 *   node dist/scripts/migrate-hosted-to-native.js           # report
 *   node dist/scripts/migrate-hosted-to-native.js --apply   # migrate
 */
import mongoose from 'mongoose';

const { migrateHostedInstallsToNative } = require('../services/hostedEngineMigration');

export const main = async (argv: string[]): Promise<number> => {
  await mongoose.connect(String(process.env.MONGO_URI));
  try {
    const report = await migrateHostedInstallsToNative({ apply: argv.includes('--apply') });
    console.log(JSON.stringify(report, null, 2));
    return report.identities.some((entry: { error?: string }) => entry.error) ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
