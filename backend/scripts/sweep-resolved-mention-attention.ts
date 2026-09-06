/**
 * Resolve legacy mention AttentionItems whose recipient already replied in
 * the same thread or to the source message, after it was posted. Unrelated
 * posts do not qualify. Already-resolved items are not changed by this script.
 *
 * Dry run by default:
 *   npm run sweep:resolved-mention-attention
 * Apply the source-backed results:
 *   npm run sweep:resolved-mention-attention -- --apply
 */
/* eslint-disable no-console */
const mongoose = require('mongoose');
const { sweepResolvedMentionAttention } = require('../services/attentionItemService');

type PgPool = { end: () => Promise<void> };

const APPLY = process.argv.includes('--apply');

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // The sweep reads legacy PostgreSQL mention sources as well as Mongo ones.
  // Close that pool like the attention backfill does so the one-shot process
  // exits after printing its measured result.
  // eslint-disable-next-line global-require
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await sweepResolvedMentionAttention({ apply: APPLY });
    console.log(JSON.stringify({ ...result, apply: APPLY }));
    if (!APPLY) console.log('DRY RUN — no AttentionItems changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
    if (pool) await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('mention attention sweep failed:', error);
    process.exit(1);
  });
}
