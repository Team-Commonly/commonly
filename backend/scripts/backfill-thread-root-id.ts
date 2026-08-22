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
 * POPULATION IS RE-MEASURED AT RUN TIME, NEVER QUOTED (@ux-lead, #1115 ruling).
 * The dry run below prints the live count and the cutoff it would record
 * before anything is written — that output is the authoritative number, and
 * it is the one to put in a PR body or a deploy note.
 *
 * Every figure in this header is a DATED OBSERVATION kept for shape and order
 * of magnitude, not a current fact. They already disagreed with each other
 * within a day of being taken: 227 edges / 153 threads on 2026-08-21, 245 /
 * 172 on 2026-08-22. Quoting either as "the" number is how a stale count ends
 * up in a merge note describing a migration that touched something else.
 *
 * Shape, 2026-08-21: ~6,300 messages, a couple of hundred reply edges, mean
 * chain ~2.5 and longest 7. So: a few-hundred-row UPDATE, not a table
 * rewrite. That conclusion survives the drift; the digits do not.
 *
 * IDEMPOTENT. Only touches rows with a reply edge and a NULL root, so a second
 * run is a no-op. DRY RUN BY DEFAULT — pass --apply to write.
 *
 * ORDERING PRECONDITION — RUN THIS *AFTER* DERIVATION-ON-WRITE IS DEPLOYED.
 * Not a nicety. The zero-edges branch below writes the ledger row with a NULL
 * cutoff, meaning "ran, and there was no pre-threading history". That reading
 * is only true once derivation is live, because from then on every new reply
 * carries a root and the un-rooted population is closed.
 *
 * Run it BEFORE the deploy and zero edges means "not yet" rather than "none" —
 * the null cutoff would be wrong, and `ON CONFLICT DO NOTHING` would make it
 * permanent: a later correct run cannot replace it. The surface would then
 * collapse pre-existing threads on an instance that does have history.
 *
 * On this instance derivation deployed 2026-08-22 16:01:52Z and the backfill
 * had not yet run, so the ordering held. Stated here because it was a
 * constraint nobody had written down (@sprint-review, pod 56911) and it is
 * invisible from either the script or the deploy in isolation.
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
 * Dated observation, live instance 2026-08-22 — kept because the SHAPE is
 * what the two consequences below turn on, not the digits. Re-measure before
 * citing any of it:
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
// Operator's assertion that derivation-on-write is deployed, for the one case
// the script cannot determine: zero eligible edges and no positive evidence.
const ASSUME_DERIVATION_LIVE = process.argv.includes('--derivation-live');

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
/**
 * POSITIVE evidence that derivation-on-write is live: any message that has a
 * reply edge AND a root can only have been written by it (the backfill has not
 * run, or these rows would not be the question).
 *
 * Presence is proof. Absence is NOT proof of the opposite — a live instance
 * with no replies yet looks identical to one whose backend predates the
 * feature. That asymmetry is why the zero-edges branch asks rather than
 * assumes: @sprint-review (56912) pointed out the header warned about the
 * ordering and nothing checked it, and a warning is the part people skip.
 */
export const DERIVATION_LIVE_SQL = `
  SELECT 1 FROM messages
   WHERE reply_to_message_id IS NOT NULL AND thread_root_id IS NOT NULL
   LIMIT 1`;

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
      // ZERO EDGES STILL WRITES THE LEDGER ROW. Per the merged ruling, a
      // missing row means "cutoff unknown" and the surface then expands every
      // thread — the non-destructive render. If a fresh instance could finish
      // this script without a row, it would sit in that permanently-expanded
      // state forever while being perfectly migrated.
      //
      // "Ran and rooted nothing" is knowledge. Absence of a row is not. The
      // whole safety of "missing means unknown" depends on a migrated instance
      // being unable to present a missing row, and this is the branch that
      // would otherwise break it.
      // Zero eligible edges is ambiguous, and the two readings write opposite
      // records. Derivation live => genuinely no pre-threading history, and a
      // null cutoff is correct. Derivation NOT live => the population is still
      // growing, and a null cutoff is wrong AND permanent, because the DO
      // NOTHING that protects a correct boundary equally freezes an incorrect
      // one. So: take positive evidence if it exists, and otherwise ASK rather
      // than assume.
      const { rows: evidence } = await pool.query(DERIVATION_LIVE_SQL);
      const derivationProven = evidence.length > 0;

      if (!derivationProven && !ASSUME_DERIVATION_LIVE) {
        console.error(
          'REFUSING to record a null cutoff: nothing to root, and no evidence '
          + 'that derivation-on-write is deployed (no message has both a reply '
          + 'edge and a root).\n'
          + 'If the backend HAS shipped derivation, this is a genuinely empty '
          + 'instance — re-run with --derivation-live to confirm and record.\n'
          + 'If it has NOT, deploy first: recording now writes a wrong boundary '
          + 'that ON CONFLICT DO NOTHING makes permanent.',
        );
        process.exitCode = 3;
        return;
      }

      if (APPLY) {
        await pool.query(
          `INSERT INTO migration_records (name, details)
           VALUES ($1, $2::jsonb)
           ON CONFLICT (name) DO NOTHING`,
          [MIGRATION_NAME, JSON.stringify({
            threadingCutoff: null,
            rowsUpdated: 0,
            rowsEligible: 0,
            // How we concluded the instance really is empty, so a later reader
            // can tell evidence from an operator's assertion.
            derivationEvidence: derivationProven ? 'observed' : 'asserted-by-flag',
          })],
        );
        console.log(`nothing to root — recorded ${MIGRATION_NAME} with a null cutoff `
          + `(${derivationProven ? 'derivation observed' : 'operator-asserted'}).`);
      } else {
        console.log(`nothing to root. --apply would record the ledger row `
          + `(${derivationProven ? 'derivation observed' : 'operator-asserted'}).`);
      }
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
