#!/usr/bin/env node
/*
 * Report or purge the stranger journey's throwaway accounts (TASK-260). The
 * selection, the refusals and the per-collection counts live in
 * services/syntheticAccountPurgeService.ts; the backend scheduler runs the same
 * function at 02:47 and 14:47 UTC when SYNTHETIC_ACCOUNT_PURGE=true. This is
 * the operator's view of it: dry run by default, `--apply` to delete.
 *
 * Usage (inside the backend pod, where MONGO_URI and PG_* are set):
 *   node dist/scripts/purge-synthetic-accounts.js                    # report
 *   node dist/scripts/purge-synthetic-accounts.js --apply            # delete
 *   node dist/scripts/purge-synthetic-accounts.js --min-age-hours 0  # include fresh ones
 */
import mongoose from 'mongoose';

const { purgeSyntheticAccounts } = require('../services/syntheticAccountPurgeService');

export const parseArgs = (argv: string[]) => {
  const at = argv.indexOf('--min-age-hours');
  const hours = at >= 0 ? Number(argv[at + 1]) : 2;
  if (!Number.isFinite(hours) || hours < 0) throw new Error('--min-age-hours must be a number >= 0');
  return { apply: argv.includes('--apply'), minAgeMs: hours * 60 * 60 * 1000 };
};

export const main = async (argv: string[]): Promise<number> => {
  const options = parseArgs(argv);
  await mongoose.connect(String(process.env.MONGO_URI));
  try {
    const report = await purgeSyntheticAccounts(options);
    console.log(JSON.stringify(report, null, 2));
    return 0;
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
