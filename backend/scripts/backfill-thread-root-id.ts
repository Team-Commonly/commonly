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
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES ONCE WAKE-SCOPING LANDS. Read this before running --apply.
 *
 * On its own this script is inert: it writes a column nothing reads, and no
 * behaviour changes. The composition is what matters, and it is visible in
 * neither this diff nor the wake-scoping one (raised by @sprint-review, 56773).
 *
 * Wake-scoping makes thread membership decide who is woken by a reply:
 * ambient-only, so an un-addressed reply inside a thread reaches
 * (participants ∪ explicit followers) − muted, instead of the room. Composed
 * with this backfill, THE ROWS WRITTEN HERE RETROACTIVELY DECIDE THE WAKE SET
 * OF EVERY CONVERSATION THAT PREDATES THE FEATURE. Nobody in those threads
 * opted into being scoped by them.
 *
 * Measured on the live instance 2026-08-22, one day after the population
 * figures above (the counts drift; the script is idempotent, so re-measure
 * rather than trusting either number):
 *
 *   245 reply edges · 172 threads · 0 orphaned edges · 6 pods
 *   participants per thread: min 1, median 2, max 3
 *   20 threads have exactly ONE participant — a self-reply chain
 *
 * Two consequences worth a reviewer's attention:
 *
 * 1. REACH DROPS RETROACTIVELY. In the busiest affected pod (135 of the 172
 *    threads, 9 distinct authors), a reply into a backfilled thread reaches a
 *    median of 2 of 9 — where before threading it reached all 9.
 *
 * 2. THE SELF-REPLY CHAINS ARE THE SHARP EDGE. 20 threads across 2 pods
 *    (19 threads / 59 messages in one, 1 thread / 2 messages in the other)
 *    have a single participant. Their wake set after scoping is one person:
 *    the author replying to themselves. An un-addressed reply into one of
 *    those reaches nobody.
 *
 * NOT overstated: ambient-only scoping does NOT suppress explicit @mentions,
 * so an addressed reply still wakes its target in every case above. The
 * exposure is un-addressed replies into backfilled threads.
 *
 * The orphan branch below (parent missing => leave NULL) currently has a live
 * population of ZERO, so it is an untested safety branch rather than a
 * measured behaviour. Do not cite it as verified.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable no-console */
import { Pool } from 'pg';

const APPLY = process.argv.includes('--apply');

// Re-exported for callers that already import this script. The NAME itself
// lives in constants/migrations.ts, which has no side effects — see the note
// there about requiring this file having executed the migration.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { THREADING_BACKFILL_MIGRATION } = require('../constants/migrations');

export const MIGRATION_NAME = THREADING_BACKFILL_MIGRATION;

/**
 * The threading cutoff: the newest message that carries a reply edge and no
 * root. "Has a reply edge and no root" IS the definition of "written before
 * derivation-on-write shipped", so this boundary is exact rather than
 * approximate — not a deploy timestamp guessed after the fact.
 *
 * Read BEFORE the UPDATE. The UPDATE eliminates the predicate, so afterwards
 * there is nothing left to measure. A hardcoded date would be wrong on every
 * instance that migrates on a different day, and self-hosting is in scope.
 *
 * NULL when there is nothing to backfill — a fresh instance has no
 * pre-threading history, so no root is pre-cutoff and the surface rule is
 * simply inert. Consumers must treat NULL as "no pre-cutoff roots exist",
 * never as "unknown, assume everything is pre-cutoff".
 */
export const CUTOFF_SQL = `
  SELECT MAX(created_at) AS cutoff
    FROM messages
   WHERE reply_to_message_id IS NOT NULL AND thread_root_id IS NULL`;

async function main(): Promise<void> {
  if (!process.env.PG_HOST) {
    console.error('PG_HOST is required');
    process.exit(2);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const fs = require('fs');
  const caPath = process.env.PG_SSL_CA_PATH;
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    // SSL decided the same way config/db-pg does — presence of PG_SSL_CA_PATH,
    // not a hardcoded object. This was `ssl: { rejectUnauthorized: false }`,
    // which makes the script UNRUNNABLE against any Postgres without SSL: it
    // fails with "The server does not support SSL connections" before reading
    // a single row. That is `./dev.sh up`, a plain docker postgres, and any
    // self-hosted instance — and self-hosting is in scope for the cutoff this
    // script records. Found by rehearsing the migration against a local
    // postgres:16 rather than only against the dev cluster.
    //
    // rejectUnauthorized: true when a CA is supplied, matching db-pg. The old
    // `false` silently accepted any certificate on the one path where it did
    // work, which is a weaker posture than the app's own connection.
    ssl: caPath && fs.existsSync(caPath)
      ? { rejectUnauthorized: true, ca: fs.readFileSync(caPath).toString() }
      : false,
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
      const { rows: [boundary] } = await pool.query(CUTOFF_SQL);
      console.log(`would record cutoff = ${boundary.cutoff ?? '(none)'} (newest pre-threading reply)`);
      console.log('DRY RUN — nothing written. Re-run with --apply.');
      return;
    }

    // MUST be read BEFORE the UPDATE. The predicate is "has a reply edge and
    // no root", which is precisely "written before derivation-on-write
    // shipped" — every row written after carries a root. The UPDATE destroys
    // that predicate, so afterwards the boundary is unrecoverable.
    const { rows: [boundary] } = await pool.query(CUTOFF_SQL);

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

    // The ruling in #1115 says pre-cutoff roots render expanded, with the
    // cutoff "read from the migration record". This script is the only process
    // that ever knows it, and until now it discarded it (@sprint-review 56860).
    //
    // ON CONFLICT DO NOTHING, not DO UPDATE: a second run must not move a
    // boundary the surface has already been rendering against. The script stays
    // idempotent; the FIRST run's answer is the true one, because by the second
    // run the population it measured no longer exists.
    await pool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (name) DO NOTHING`,
      [
        MIGRATION_NAME,
        JSON.stringify({
          threadingCutoff: boundary.cutoff,
          rowsUpdated: result.rowCount,
          rowsEligible: before.needs_root,
        }),
      ],
    );
    console.log(`recorded ${MIGRATION_NAME}: cutoff = ${boundary.cutoff ?? '(none)'}`);

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

// Only when RUN, never when required. Importing this file used to execute the
// whole migration — threadStateController pulled one constant out of it and
// took the server down at boot (CI caught it; no local run did, because none
// of them loaded server.ts).
if (require.main === module) {
  main();
}
