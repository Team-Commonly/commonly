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
   Add its name to `SHIPPED` in `backend/__tests__/service/pgMigrations.test.js`;
   two lanes taking the same number then conflict on that line.
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
Since step 2 the repository is built on the dual-store helper
(`repositories/dualStore.ts`) and the cursor has a Postgres table,
`agent_pod_read_cursors` (`0016`). `STORE_MODE_AGENT_POD_READ_CURSOR` selects
the store; unset means `mongo`, which makes no Postgres call. **Mongo remains
authoritative** until step 4. Moving it, with rollback for each step:
[`docs/runbooks/adr-034-model-move.md`](../runbooks/adr-034-model-move.md).

- `getReadWatermark(agentUserId, podId)` returns a plain
  `{readAt: Date, readRevision?: number}` or null.
- `advanceReadWatermark(agentUserId, podId, watermark)` resolves after writing.
  It keeps the deterministic `agent:pod` key, independent `$max` timestamp and
  revision updates, omitted-revision behavior, and duplicate-upsert loser retry.
  Other Mongo errors propagate to the freshness gate. A Postgres error in
  `dual` or `pg-read` does not: the write stands in Mongo, flagged for repair.

## Second model: AgentFirstContact

`AgentFirstContact` (the durable record that a person and an agent have met)
follows the same template. Its table is `agent_first_contacts` (`0017`): the
Mongo `_id` as `id`, the natural key `(user_id, agent_name, instance_id)` under
a unique index, `greeted_at_by_pod` as JSONB, and a nullable `created_at`.
`STORE_MODE_AGENT_FIRST_CONTACT` selects the store. Production callers import
`repositories/agentFirstContactRepository`; ESLint fences the model as it does
the cursor.

- `claimFirstContact(identity, fields)` resolves `{ inserted }`, true only for
  the call that created the marker (a `$setOnInsert` upsert). A duplicate-key
  error from two first claims racing still propagates to the caller.
- `claimPodGreeting(identity, podId, now, expiredBefore)` resolves true only
  for the call that stamped `greetedAtByPod.<podId>` (absent, or older than
  `expiredBefore`).

Both claims run in Mongo in `mongo`, `dual` and `pg-read`. In `mongo` they call
`AgentFirstContact.findOneAndUpdate` directly, as before, without the helper. In `dual`
and `pg-read` they go through the helper's `insertIfAbsent` and `setWhere`, and only a won
claim takes a version and is copied.
`pg` mode refuses both until step 4.

## Third model: AgentDigestState

`AgentDigestState` (the per-seat count of unread ambient events folded out of
the AgentEvent retention window) follows the same template. Its table is
`agent_digest_states` (`0018`): the Mongo `_id` as `id`, the natural key
`(agent_name, instance_id, pod_id)` under a unique index, an index on
`(unread_count, unread_since)` for the wake scan, `conversations` and
`last_event_ids` as JSONB, and nullable `unread_since`, `folded_through_id`,
`created_at` and `updated_at`. `STORE_MODE_AGENT_DIGEST_STATE` selects the
store. Production callers (`services/agentDigestFoldService.ts`,
`services/schedulerService.ts`) import `repositories/agentDigestStateRepository`;
ESLint fences the model. Settling zeroes the row; nothing deletes one.

- `getFoldState(scope)` returns `{foldedThroughId, unreadCount, conversations,
  otherCount}` or null.
- `startFoldState(scope, fields)` resolves true when it created the state and
  false on a duplicate key (another worker created it first).
- `advanceFold(scope, expected, change)` resolves true only if the state was
  still at `expected` (its cursor and unread count) and took the fold step.
- `readUnreadDigest(scope)` returns the unread summary or null.
- `settleDigest(scope, revision)` clears the summary only at that revision.
- `listDueForWake(threshold)` lists the scopes unread since `threshold` or
  earlier, for the unread-digest wake.

In `mongo` every operation makes the pre-step-2 Mongoose call, without the
helper. In `dual` and `pg-read` the two conditional updates go through the
helper's `updateWhere`: the operator update rewritten as pipeline stages (`$inc`
as `$add`, the capped `$push` as `$slice` over `$concatArrays`), with the
version and marker in the same write. The three reads go through `findOneWhere`
and `findWhere`, which read Mongo in `dual` and Postgres in `pg-read` (Mongo
while anything is flagged). Their Postgres filter accepts only equality and
`$gt`/`$gte`/`$lt`/`$lte` on declared columns, bound as parameters; anything
else throws before a query, in `dual` too. `pg` mode refuses the writes until
step 4.

## Fourth model: AgentTaskWakeState

`AgentTaskWakeState` (the per-seat throttle on assigned-task wakes, keyed by
the seat) follows the same template. Its table is `agent_task_wake_states`
(`0019`): the Mongo `_id` (the seat key) as `id`, a nullable `last_wake_at`
(releasing a slot unsets it and keeps the row), and nullable `created_at` and
`updated_at`. `STORE_MODE_AGENT_TASK_WAKE_STATE` selects the store. Its only
caller, `services/assignedTaskWakeService.ts`, imports
`repositories/agentTaskWakeStateRepository`; ESLint fences the model.

- `reserveWake(key, now, intervalMs)` resolves true only for the call that took
  the seat's slot (absent, released, or last woken `intervalMs` ago or
  earlier), and false when another worker holds it.
- `releaseWake(key, now)` returns the slot only if it is still the one taken
  at `now`.

In `mongo` both make the pre-step-2 Mongoose calls; the reservation's
duplicate-key loser is answered as false. In `dual` and `pg-read` the reserve
is the helper's `updateWhere` on a stale or released slot, then
`insertIfAbsent` on an absent one: each is one atomic Mongo write from free to
held, so exactly one racing worker wins, and a held slot matches neither. The
release is `updateWhere` with `$unset`. `pg` mode refuses both until step 4.
In dual and pg-read the helper's `insertIfAbsent` sets the timestamps on the
insert only, so a reserve that finds a held slot writes nothing.

## Fifth model: NeedsYouEmailQuota

`NeedsYouEmailQuota` (the per-recipient daily cap on needs-you emails) follows
the same template. Its table is `needs_you_email_quotas` (`0020`): the Mongo
`_id` as `id`, `recipient_user_id` (hex), `day` (`YYYY-MM-DD` text, as Mongo
stores it) and `count`, with `(recipient_user_id, day)` unique as in Mongo.
`STORE_MODE_NEEDS_YOU_EMAIL_QUOTA` selects the store. Its only caller,
`services/needsYouEmailService.ts`, imports
`repositories/needsYouEmailQuotaRepository`; ESLint fences the model.

- `claimEmailSlot(recipientUserId, day, limit)` resolves true when this call
  took one of the day's `limit` slots, and false when they are all taken. The
  limit (3) stays in the service.

In `mongo` it makes the pre-step-2 Mongoose calls: the `$setOnInsert` upsert,
whose duplicate-key loser goes on, then the conditional `$inc` below the limit.
In `dual` and `pg-read` the same two writes are the helper's `insertIfAbsent`
on `(recipientUserId, day)` and `updateWhere` with `count < limit` and a
pipeline `$add`; each slot is one atomic Mongo write, so racing claims take
exactly `limit`, and a full day writes and copies nothing. `pg` mode refuses
until step 4, before any write.

## Sixth model: AgentComputerTakeover

`AgentComputerTakeover` (a person's takeover of an agent's computer, keyed by
the AgentInstallation id and owned by one user) follows the same template. Its
table is `agent_computer_takeovers` (`0021`): the Mongo `_id` (the installation
id, hex) as `id`, `owner_id` (hex, indexed), `active`, a nullable `target_id`
(the bound browser target), and nullable `created_at` and `updated_at`.
`STORE_MODE_AGENT_COMPUTER_TAKEOVER` selects the store. Its only caller,
`services/agentComputerBroker.ts` (`takeoverStore`), imports
`repositories/agentComputerTakeoverRepository`; ESLint fences the model.

- `isTakeoverActive(userId, installationId)` is true only for the owner's
  active takeover.
- `setTakeover(userId, installationId, active)` and
  `bindTarget(userId, installationId, targetId)` upsert the owner's document; a
  first bind starts inactive.
- `listBindings(userId)` returns the owner's installations with a non-empty
  string `targetId`.

Every call is keyed by `(installation, owner)`. An installation id another
user owns is never read as theirs, and a write to it fails with Mongo's
duplicate key (11000) and changes neither store, in every mode.

In `mongo` the four make the pre-step-2 Mongoose calls. In `dual` and
`pg-read` a write is the helper's `updateWhere` on `{ _id, ownerId }`; on a
miss, `insertIfAbsent` with the same filter; and when that finds a document a
racing first call inserted, `updateWhere` once more, so the last writer's value
stands. The reads are `findOneWhere` and `findWhere` on `_id`, `ownerId` and
`active`; `listBindings` filters a missing `targetId` in code, since the
Postgres filter has no `$exists`. `pg` mode refuses the writes until step 4,
before any write.

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
