#!/usr/bin/env node
/**
 * staging-seed (TASK-697) — fill STAGING with real-shaped data for v2
 * screenshots. Safe to re-run: a second run writes nothing.
 *
 *   node dist/scripts/staging-seed.js --target=commonly-staging \
 *     [--cred-out=<path>] [--rotate]
 *
 * Refuses before connecting to anything unless the target, the running
 * namespace, MONGO_URI and PG_* all say staging (staging-seed/guard.ts), and
 * unless --cred-out is outside any git checkout. The seat password is written
 * only to --cred-out (0600) and never printed.
 * How to run it on the cluster: docs/development/ui-validation.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { assertCredOutOutsideRepo, assertStagingTarget, StagingGuardError } from './staging-seed/guard';
import type { PgPoolLike, StagingSeedReport } from './staging-seed/seed';

const SA_NAMESPACE_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
export const DEFAULT_CRED_OUT = path.join(os.homedir(), '.commonly', 'credentials', 'staging-seat-test.json');

const runningNamespace = (env: NodeJS.ProcessEnv): string | null => {
  try {
    return fs.readFileSync(SA_NAMESPACE_FILE, 'utf8').trim() || null;
  } catch {
    return env.POD_NAMESPACE || null;
  }
};

export interface StagingSeedMainDeps {
  argv: string[];
  env: NodeJS.ProcessEnv;
  readNamespace: () => string | null;
  connect: (uri: string) => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  /** Loaded only after the guard: config/db-pg builds its pool on import. */
  loadPool: () => PgPoolLike & { end?: () => Promise<unknown> };
  log: (line: string) => void;
}

const defaultDeps = (): StagingSeedMainDeps => ({
  argv: process.argv.slice(2),
  env: process.env,
  readNamespace: () => runningNamespace(process.env),
  connect: (uri) => mongoose.connect(uri),
  disconnect: () => mongoose.disconnect(),
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  loadPool: () => require('../config/db-pg').pool,
  log: (line) => console.log(line),
});

export async function main(overrides: Partial<StagingSeedMainDeps> = {}): Promise<StagingSeedReport> {
  const deps = { ...defaultDeps(), ...overrides };
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return deps.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  };

  assertStagingTarget({
    target: flag('target'),
    namespace: deps.readNamespace(),
    mongoUri: deps.env.MONGO_URI,
    pgHost: deps.env.PG_HOST,
    pgDatabase: deps.env.PG_DATABASE,
  });
  const credOut = path.resolve(flag('cred-out') || DEFAULT_CRED_OUT);
  assertCredOutOutsideRepo(credOut);

  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { runStagingSeed } = require('./staging-seed/seed');
  const pool = deps.loadPool();
  await deps.connect(deps.env.MONGO_URI as string);
  try {
    const report: StagingSeedReport = await runStagingSeed({ pool, credOut, rotate: deps.argv.includes('--rotate') });
    const mongo = Object.entries(report.mongo)
      .map(([name, t]) => `${name}=+${t.upserted}/~${t.modified}`)
      .join(' ');
    deps.log(`[staging-seed] pod ${report.podId} | mongo ${mongo} | pg users=+${report.pg.users} `
      + `pods=+${report.pg.pods} members=+${report.pg.members} messages=+${report.pg.messages}`);
    deps.log(report.seatPassword === 'unchanged'
      ? '[staging-seed] seat password unchanged (pass --rotate to issue a new one)'
      : `[staging-seed] seat password ${report.seatPassword}; credentials written to ${credOut}`);
    return report;
  } finally {
    await deps.disconnect();
    await pool?.end?.();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof StagingGuardError ? error.message : `[staging-seed] failed: ${(error as Error).message}`);
    process.exit(1);
  });
}
