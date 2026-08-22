/**
 * backfill-thread-root-id — one-shot, for the reply edges that predate
 * threading (W-T, TASK-029).
 *
 * `Message.create` derives `thread_root_id` on write from the parent's
 * COALESCE(thread_root_id, id). Rows written before that shipped have a
 * `reply_to_message_id` and a NULL root, so a thread that began yesterday
 * would render as a set of unrelated messages.
 *
 * WHY BACKFILL RATHER THAN DERIVE ON READ. The root is computable at any time
 * by walking the reply chain — that is how the population below was measured.
 * But `reply_to_message_id` carries no index, so each walk is a sequential
 * scan per level, and threading exists to be read. Two fields that can
 * disagree about what a thread is will eventually disagree; one write now
 * costs less than reconciling them later.
 *
 * POPULATION, measured on the live instance 2026-08-21: 6,304 messages, of
 * which 227 carry a reply edge, forming 153 distinct threads — mean 2.48
 * messages, largest 7, chain depths 205/14/5/1/1 at levels 2-6. So this is a
 * ~227-row UPDATE, not a table rewrite.
 *
 * IDEMPOTENT. Only touches rows with a reply edge and a NULL root, so a second
 * run is a no-op. DRY RUN BY DEFAULT — pass --apply to write.
 */
/* eslint-disable no-console */
import { Pool } from 'pg';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  if (!process.env.PG_HOST) {
    console.error('PG_HOST is required');
    process.exit(2);
  }
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const { rows: [before] } = await pool.query(
      `SELECT count(*)::int AS needs_root
         FROM messages
        WHERE reply_to_message_id IS NOT NULL AND thread_root_id IS NULL`,
    );
    console.log(`rows with a reply edge and no root: ${before.needs_root}`);
    if (before.needs_root === 0) {
      console.log('nothing to do.');
      return;
    }

    if (!APPLY) {
      // Show what the walk WOULD produce, so the number can be checked before
      // it is written — the recursive CTE is the same one that measured the
      // population, and it is the only place the chain is walked.
      const { rows } = await pool.query(
        `WITH RECURSIVE chain AS (
           SELECT id, reply_to_message_id, id AS root
             FROM messages WHERE reply_to_message_id IS NULL
           UNION ALL
           SELECT m.id, m.reply_to_message_id, c.root
             FROM messages m JOIN chain c ON m.reply_to_message_id = c.id
         )
         SELECT count(*)::int AS resolvable,
                count(DISTINCT root)::int AS threads
           FROM chain
          WHERE id IN (SELECT id FROM messages
                        WHERE reply_to_message_id IS NOT NULL AND thread_root_id IS NULL)`,
      );
      console.log(`would set a root on ${rows[0].resolvable} rows across ${rows[0].threads} threads`);
      if (rows[0].resolvable !== before.needs_root) {
        console.warn(
          `WARNING: ${before.needs_root - rows[0].resolvable} row(s) have a reply edge whose `
          + 'chain does not terminate at a root — orphaned parents, deleted mid-chain. '
          + 'Those stay NULL and render unthreaded, which is correct: an unreachable root is not a thread.',
        );
      }
      console.log('DRY RUN — nothing written. Re-run with --apply.');
      return;
    }

    const result = await pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, reply_to_message_id, id AS root
           FROM messages WHERE reply_to_message_id IS NULL
         UNION ALL
         SELECT m.id, m.reply_to_message_id, c.root
           FROM messages m JOIN chain c ON m.reply_to_message_id = c.id
       )
       UPDATE messages m
          SET thread_root_id = chain.root
         FROM chain
        WHERE m.id = chain.id
          AND m.reply_to_message_id IS NOT NULL
          AND m.thread_root_id IS NULL
          AND chain.root <> m.id`,
    );
    console.log(`APPLIED — ${result.rowCount} of ${before.needs_root} rows updated.`);

    const { rows: [after] } = await pool.query(
      `SELECT count(*)::int AS still_null
         FROM messages
        WHERE reply_to_message_id IS NOT NULL AND thread_root_id IS NULL`,
    );
    console.log(`remaining with a reply edge and no root: ${after.still_null} (orphaned chains stay NULL by design)`);
  } catch (error) {
    console.error('backfill failed:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
