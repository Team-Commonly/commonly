#!/usr/bin/env node
/**
 * staging-seed (TASK-697) — fill STAGING with real-shaped data for v2
 * screenshots. Safe to re-run: a second run writes nothing.
 *
 *   node dist/scripts/staging-seed.js --target=commonly-staging \
 *     [--cred-out=<path>] [--rotate]
 *
 * Refuses before connecting to anything unless the target, the running
 * namespace, MONGO_URI and PG_* all say staging (staging-seed/guard.ts).
 * The seat password is written only to --cred-out (0600) and never printed.
 * How to run it on the cluster: docs/development/ui-validation.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { assertStagingTarget, StagingGuardError } from './staging-seed/guard';

const SA_NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
export const DEFAULT_CRED_OUT = path.join(os.homedir(), '.commonly', 'credentials', 'staging-seat-test.json');

const flag = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const runningNamespace = (): string | null => {
  try {
    return fs.readFileSync(SA_NAMESPACE_FILE, 'utf8').trim() || null;
  } catch {
    return process.env.POD_NAMESPACE || null;
  }
};

async function main(): Promise<void> {
  assertStagingTarget({
    target: flag('target'),
    namespace: runningNamespace(),
    mongoUri: process.env.MONGO_URI,
    pgHost: process.env.PG_HOST,
    pgDatabase: process.env.PG_DATABASE,
  });

  // Required only after the guard: config/db-pg builds its pool on import.
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg');
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { runStagingSeed } = require('./staging-seed/seed');
  const credOut = path.resolve(flag('cred-out') || DEFAULT_CRED_OUT);

  await mongoose.connect(process.env.MONGO_URI as string);
  try {
    const report = await runStagingSeed({ pool, credOut, rotate: process.argv.includes('--rotate') });
    const mongo = Object.entries(report.mongo)
      .map(([name, t]) => `${name}=+${(t as { upserted: number }).upserted}/~${(t as { modified: number }).modified}`)
      .join(' ');
    console.log(`[staging-seed] pod ${report.podId} | mongo ${mongo} | pg users=+${report.pg.users} pods=+${report.pg.pods} members=+${report.pg.members} messages=+${report.pg.messages}`);
    console.log(report.seatPassword === 'unchanged'
      ? '[staging-seed] seat password unchanged (pass --rotate to issue a new one)'
      : `[staging-seed] seat password ${report.seatPassword}; credentials written to ${credOut}`);
  } finally {
    await mongoose.disconnect();
    await pool?.end?.();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof StagingGuardError ? error.message : `[staging-seed] failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
