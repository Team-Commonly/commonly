# Versioned PostgreSQL changes and repository extraction

## Boot and upgrade contract

`config/init-pg-db.ts` calls `runPgMigrations` before `pgBootService` mounts PG
routes or reports readiness. A failure returns false to the existing retry loop.
Each runner checks out **one connection**, takes the session advisory lock
`(1129270605, 504)`, reads history, and runs pending files in filename order.
Competing backend boots wait for that session to unlock, then reread history.
A process exit releases its session lock through PostgreSQL.

Files live in `backend/config/migrations/NNNN_name.sql`. Four-digit versions
must be unique. Each file's SQL and its `schema_migrations` row commit in one
transaction. A failed file rolls back and can be retried. Earlier successful
files remain committed. The row stores filename, SHA-256 and application time.
Edited or removed applied files, and files inserted before applied history,
refuse boot. Add a new numbered file to correct an applied migration.

`0001_legacy_schema.sql` freezes the former boot DDL, including its existing
retrofit ALTERs. On an existing instance it runs once without discarding rows;
on a fresh instance it creates the schema. `config/schema.sql` is a compatibility
symlink to this frozen baseline for older fixtures/scripts, **not the latest
schema**. New schema tests should call the runner. `migration_records` remains
the separate application/backfill ledger (including threading cutoff details);
its rows do not determine which SQL files the runner executes.

## Adding a migration

1. Pick the next unused `NNNN_name.sql`. Coordinate numbers across open lanes.
2. Write SQL that upgrades a populated previous schema. A column inside
   `CREATE TABLE IF NOT EXISTS` alone never upgrades an existing table. Keep
   rolling old/new application versions compatible with additive changes.
3. Do not include BEGIN/COMMIT/ROLLBACK, change the runner's lock, or use
   commands that cannot run in a transaction (such as CREATE INDEX CONCURRENTLY).
   Large online index builds and data backfills remain separate operator jobs.
4. Test both an empty database and the previous populated shape. Verify failure
   rolls back DDL and its ledger row; rerun to prove completed SQL is skipped.
5. Run `npm --prefix backend run build`. The build copies SQL assets into
   `dist/config/migrations`; the backend Docker build uses the same command.

There is no automatic down migration. This image refuses a database whose
recorded migrations it does not carry, so rolling back an image after new SQL
ran requires a compatible image carrying that migration history. Do not delete
history to bypass this check. Take a backup before destructive migrations and
ship destructive changes only after old application versions are drained.

## Repository template: AgentPodReadCursor

Production callers import `repositories/agentPodReadCursorRepository`, never
`models/AgentPodReadCursor`. ESLint checks both imports and require calls for
this extracted model. Model tests may still seed and inspect real Mongo rows.
The model/schema is unchanged in this extraction; **Mongo is the only cursor
store** and remains authoritative. No dual writes, shadow reads or PG cursor
table are introduced here.

- `getReadWatermark(agentUserId, podId)` returns a plain
  `{readAt: Date, readRevision?: number}` or null.
- `advanceReadWatermark(agentUserId, podId, watermark)` resolves after writing.
  It keeps the deterministic `agent:pod` key, independent `$max` timestamp and
  revision updates, omitted-revision behavior, and duplicate-upsert loser retry.
  Other database errors propagate to the freshness gate.

For the next aggregate, expose its domain operations, keep Mongoose queries
inside its repository, and return plain values. Do not expose `find`, `save`,
`populate`, or a generic query builder. Extract without changing storage first,
then compare existing service behavior against a real database. A later storage
switch belongs inside that module and needs its own authority/partial-write
contract before dual writes begin.

## Verification

The pg-mem suite executes ordering, retrofit, history and repeat-boot checks.
Its advisory functions are stubs; it **does not establish lock or transaction
semantics**. The service suite uses an isolated schema on real PostgreSQL for
fresh/legacy baseline, DDL rollback/retry, and two competing boot sessions.
The completion-row failure case is essential: PostgreSQL can roll back a
multi-statement SQL query even without an explicit BEGIN. Failing only inside
that query would not prove the SQL and the separate ledger INSERT are atomic.
The Mongo repository suite round-trips rows and races concurrent first reads.

```sh
cd backend
npx jest --runInBand --runTestsByPath \
  __tests__/unit/config/run-pg-migrations.test.js \
  __tests__/unit/repositories/agentPodReadCursorRepository.test.js
INTEGRATION_TEST=true PG_HOST=localhost PG_PORT=5432 \
  PG_DATABASE=commonly-test PG_USER=postgres PG_PASSWORD=postgres \
  npx jest --runInBand --runTestsByPath __tests__/service/pgMigrations.test.js
```

The real test role needs CREATE SCHEMA in a test database. Each case creates
and drops its own schema; it never drops the database or truncates other schemas.
