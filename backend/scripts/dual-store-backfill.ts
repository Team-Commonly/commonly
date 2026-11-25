/**
 * dual-store-backfill — ADR-034 step 2's history copy and step 3's gate, for
 * one model that has adopted the dual-store helper (repositories/dualStore.ts).
 * The procedure around it: docs/runbooks/adr-034-model-move.md.
 *
 *   node dist/scripts/dual-store-backfill.js --model AgentPodReadCursor            # dry run (default)
 *   node dist/scripts/dual-store-backfill.js --model AgentPodReadCursor --apply
 *   node dist/scripts/dual-store-backfill.js --model AgentPodReadCursor --verify
 *
 * The dry run and --apply need the model's STORE_MODE_<MODEL> at dual or
 * pg-read in this process's environment, as on every serving replica: the
 * helper refuses otherwise, because a replica still in mongo writes without
 * bumping the version the copy relies on. --apply copies each live document
 * with no pending marker at its own version, so a concurrent dual write always
 * wins. --verify writes nothing; it compares every live document with its row
 * and exits 1 on any missing, differing or extra row, or differing checksums.
 *
 * Prints counts and checksums only, never an id or a value. Models are listed
 * in repositories/dualStoreRegistry.ts. Exit codes: 0 done, 1 a verify
 * difference or a failed run.
 */
import mongoose from 'mongoose';
import type { DualStore } from '../repositories/dualStore';

export interface DualStoreBackfillArgs { model: string; action: 'dry-run' | 'apply' | 'verify' }

/** Reads the flags after `node script`. Any other argument throws, so a typo cannot pick an action. */
export const parseArgs = (argv: string[], models: string[]): DualStoreBackfillArgs => {
  let model: string | undefined;
  const actions = new Set<DualStoreBackfillArgs['action']>();
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--model') {
      model = rest[i + 1];
      i += 1;
    } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
    else if (arg === '--dry-run') actions.add('dry-run');
    else if (arg === '--apply') actions.add('apply');
    else if (arg === '--verify') actions.add('verify');
    else {
      const expected = '--model <name> and one of --dry-run, --apply, --verify';
      throw new Error(`unknown argument ${JSON.stringify(arg)}; expected ${expected}`);
    }
  }
  if (!model || !models.includes(model)) {
    const got = model === undefined ? 'nothing' : JSON.stringify(model);
    throw new Error(`--model must be one of ${models.join(', ')}; got ${got}`);
  }
  if (actions.size > 1) throw new Error('--dry-run, --apply and --verify are exclusive');
  return { model, action: [...actions][0] ?? 'dry-run' };
};

export interface OpenedStores { models: Record<string, () => DualStore>; close: () => Promise<void> }

/** Connects both stores for a real run. main() takes it as a parameter so a test can swap it. */
export const openStores = async (): Promise<OpenedStores> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg') as { pool: { end: () => Promise<void> } | null };
  if (!pool) throw new Error('PostgreSQL is not configured (PG_HOST unset)');
  await mongoose.connect(process.env.MONGO_URI);
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { DUAL_STORED_MODELS } = require('../repositories/dualStoreRegistry');
  return {
    models: DUAL_STORED_MODELS,
    close: async () => { await mongoose.disconnect(); await pool.end(); },
  };
};

/** Lists the registered models without connecting, for argument checking. */
const registeredModels = (): string[] => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { DUAL_STORED_MODELS } = require('../repositories/dualStoreRegistry');
  return Object.keys(DUAL_STORED_MODELS);
};

/** Runs one action, sets process.exitCode and returns it. */
export async function main(
  argv: string[] = process.argv,
  open: () => Promise<OpenedStores> = openStores,
  models: string[] = registeredModels(),
): Promise<number> {
  const { model, action } = parseArgs(argv, models);
  const opened = await open();
  try {
    const store = opened.models[model]();
    if (action === 'verify') {
      const result = await store.verify();
      console.log(`[dual-store-backfill] verify model=${model} ${JSON.stringify(result)}`);
      const clean = !result.missing && !result.differs && !result.extra && result.checksumMongo === result.checksumPg;
      if (!clean) console.log('MongoDB and PostgreSQL differ; the warnings above name each row by hashed id.');
      process.exitCode = clean ? 0 : 1;
      return process.exitCode;
    }
    const counts = await store.backfill({ dryRun: action === 'dry-run' });
    console.log(`[dual-store-backfill] ${action} model=${model} ${JSON.stringify(counts)}`);
    if (action === 'dry-run') console.log('DRY RUN — nothing written. Re-run with --apply.');
    if (counts.skippedPending) {
      console.log(`${counts.skippedPending} document(s) carry a pending marker; the repair job copies those.`);
    }
    process.exitCode = 0;
    return 0;
  } finally {
    await opened.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // A driver error can quote a stored value, so only this script's and the
    // helper's own messages are printed in full.
    const { message, name, code } = error as Error & { code?: string };
    const own = /^(dual-store:|--|unknown argument|MONGO_URI|PostgreSQL is not configured)/.test(message);
    console.error('dual-store backfill failed:', own ? message : `${name}${code ? ` ${code}` : ''}`);
    process.exit(1);
  });
}
