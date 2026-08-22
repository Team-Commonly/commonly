/**
 * Migration record names, shared between the script that WRITES a record and
 * the code that READS it.
 *
 * A tiny module with no imports, on purpose. The reader previously took this
 * name from the backfill script itself — which calls `main()` at module scope,
 * so `require`ing it to read one string EXECUTED THE MIGRATION. In CI that
 * surfaced as `process.exit(2)` ("PG_HOST is required") during
 * `server.test.js`, reached via server.ts → routes/messages.ts →
 * threadStateController. In production, where PG_HOST is set, it would not
 * have exited — it would have opened a pool and run the script's queries on
 * every server boot.
 *
 * Rule: a constant shared between a script and a service belongs in a module
 * with no side effects, never in whichever file happened to define it first.
 */

/** Written by scripts/backfill-thread-root-id.ts; read by threadStateController. */
export const THREADING_BACKFILL_MIGRATION = 'threading-thread-root-id-backfill';

module.exports = { THREADING_BACKFILL_MIGRATION };
Object.assign(module.exports, exports);
