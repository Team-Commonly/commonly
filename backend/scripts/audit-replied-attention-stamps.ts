/**
 * Audit mention AttentionItems stamped `resolvedBy: 'replied'`. The broad
 * pre-#1573 resolver closed every open mention a recipient held in a pod as
 * soon as they posted anything there, so some of those stamps assert a reply
 * nobody wrote. This re-reads each row's source and reopens only the rows the
 * source contradicts; rows whose source cannot answer the question are
 * counted and left alone.
 *
 * Dry run by default:
 *   npm run audit:replied-attention-stamps
 * Bound the population to stamps written before the narrow resolver deployed:
 *   npm run audit:replied-attention-stamps -- --resolved-before=2026-09-06T00:00:00Z
 * Apply the source-backed reopens:
 *   npm run audit:replied-attention-stamps -- --apply
 */
/* eslint-disable no-console */
const mongoose = require('mongoose');
const { auditRepliedMentionAttention } = require('../services/attentionItemService');

type PgPool = { end: () => Promise<void> };

const APPLY = process.argv.includes('--apply');
const BEFORE_ARG = process.argv.find((arg) => arg.startsWith('--resolved-before='));

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  let resolvedBefore: Date | undefined;
  if (BEFORE_ARG) {
    const parsed = new Date(BEFORE_ARG.split('=').slice(1).join('='));
    // An unparsable bound would silently widen the audit to every stamp ever
    // written, which is the opposite of what the flag was passed to do.
    if (Number.isNaN(parsed.getTime())) throw new Error(`--resolved-before is not a date: ${BEFORE_ARG}`);
    resolvedBefore = parsed;
  }
  // The audit reads legacy PostgreSQL mention sources as well as Mongo ones.
  // Close that pool like the sweep does so the one-shot process exits after
  // printing its measured result.
  // eslint-disable-next-line global-require
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await auditRepliedMentionAttention({ apply: APPLY, resolvedBefore });
    console.log(JSON.stringify({ ...result, apply: APPLY, resolvedBefore: resolvedBefore?.toISOString() || null }));
    if (!APPLY) console.log('DRY RUN — no AttentionItems changed. Re-run with --apply after review.');
  } finally {
    await mongoose.disconnect();
    if (pool) await pool.end();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('replied-stamp audit failed:', error);
    process.exit(1);
  });
}
