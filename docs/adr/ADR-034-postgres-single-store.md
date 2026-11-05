# ADR-034: Postgres is the single data store

**Status:** **Accepted** 2026-11-02 as the direction. The project's founder set it on 2026-10-25:
Mongo plus Postgres makes self-hosting hard, so the target is Postgres only. **Accepting the
direction does not settle three things, and each is named where it lives:** the effort estimate
(Effort is a 10-25 estimate, not a commitment), the order inside Wave 5 (D6), and the size of the
mismatch log that a read cut may tolerate (D3 sets it at zero unexplained mismatches, which may prove
too strict for models with clock-derived fields).

**Amended 2026-11-05 (D7: considered, not adopted).** Running self-host's Mongo layer on FerretDB
was measured and walked, and the founder dropped it the same day: FerretDB's last release is v2.7.0
(2025-11-10). **Self-host is MongoDB plus Postgres**, and that path is walked nightly. All
Postgres-only work, D1 to D7, is paused until the founder reopens it. D7 stays below as the record.

**Deciders:** founder (direction), eng lead (plan).

**Scope boundary.** This ADR decides where data lives. It does not reopen these:
- **ADR-002** (attachments): `MediaObject` bytes move to an object-store driver, never to a table.
- **ADR-003** (memory): `AgentMemory` moves table with its contract unchanged.
- **ADR-033** (grant record): its record chains already live in Postgres (`0002_record_chains.sql`).
  Its Mongo rows (`RoomGrant`, `ApprovalAction`, `DecisionRequest`, `Task`) move in Wave 3.
- **The founder's decision to keep the current stack** rather than rebuild it on another platform. This
  ADR is a migration inside that stack, one model at a time, and the stack keeps working at every step.
- **The vector search index** (`services/vectorSearchService.ts`, a local SQLite file with `sqlite-vec`)
  is derived from pod content and rebuilt from it. It is an index, not a store of record.
- **ADR-011** (shell-first): this is kernel work and launch does not wait on it.
- **FerretDB (D7) was considered and not adopted.** No supported install uses it.

## Context: the split, measured at `origin/main` `e2cb8c2fc` (2026-11-02)

| | Mongo | Postgres |
|---|---|---|
| Models / tables | **70** registered model names in 69 files under `backend/models/` (`AgentRegistry.ts` registers `AgentRegistry` and `AgentInstallation`) | **14** tables: `messages`, `pod_message_revisions`, `message_reactions`, `thread_user_state`, `message_claims`, `tool_calls`, `tool_call_budgets`, `record_chains`, `record_lines`, `pg_retention_runs`, `migration_records`, plus `pods`, `pod_members` and `users`, which are **copies** of Mongo rows. The migration runner keeps its own `schema_migrations`. |
| Callers | 245 non-test, non-script files import a model from `models/` | 3 repositories under `backend/repositories/` |
| Since `136709aa0` (2026-10-25 06:15 UTC) | **+3** (`AccountDeletion` #2721, `AdminUserMutationLock` #2742, `AgentTaskRowWakeState` #2757), −2 dead (`Session`, `DiscordMessageBuffer`, #2680) | +2 (`record_chains`, `record_lines`) |

**What already moved.**
- **Messages.** On an instance with `PG_HOST` set, Postgres is the only message store (#2989).
  Mongo still holds history from before an install had Postgres, which
  `scripts/backfill-local-messages-to-pg.ts` copies under its Mongo id (`services/legacyMessageCopy.ts`).
  An instance without `PG_HOST` still writes messages to Mongo and refuses replies
  (`REPLY_REQUIRES_POSTGRES`, `controllers/messageController.ts`).
- **Schema delivery.** Versioned migrations run at boot under an advisory lock (#2684,
  `docs/database/schema-migrations.md`). Three tables still also create themselves at runtime with
  `CREATE TABLE IF NOT EXISTS`, outside the runner: `message_claims` (`services/messageClaimService.ts`),
  and `tool_calls` and `tool_call_budgets` (`models/ToolCall.ts`). `message_claims` exists only that way.
- **Repositories.** `messageRepository`, `agentPodReadCursorRepository` and `recordChainRepository`
  exist. Only `AgentPodReadCursor` is fenced by lint (`backend/.eslintrc.js`, `no-restricted-imports`).
- **Self-host.** `docker-compose.local.yml` runs Postgres beside Mongo (#2806), so `./install.sh` no
  longer runs chat on a fallback. It does need both databases.

**What makes the move tractable.** No multi-document transactions (0 `startSession` or
`withTransaction` in production code), no change streams (0 `.watch(`), three `$lookup`s, and Postgres
already keys rows by the 24-character ObjectId hex (`pods.id`, `users._id`). **What makes it large.**
about 95 `.populate(` calls in production code, 27 `Mixed` fields across 14 model files, 10 model files with
TTL indexes, and atomic claims written as single-document `findOneAndUpdate`
(`services/agentEventService.ts`, the scheduler lease).

**The image majors still differ.** Tags are exact since #2678, but the majors are not one:
Postgres 15 (helm `values.yaml`), 16 (`docker-compose.local.yml` and the backup job's `pg_dump`) and 17
(`docker-compose.dev.yml`, `docker-compose.yml`); Mongo 7, 8.2 and 9.0.4.

## Decisions

### D1. Postgres is the target store, with JSONB for document-shaped fields
Every Mongoose model moves to a Postgres table. Scalar, indexed and referenced fields become columns.
`Mixed` fields and config `Map`s become **JSONB** (`AgentEvent.payload`, `AgentRun.args` and `result`,
the five on `Installable`, `AgentInstallation.config`). A JSONB column is the honest shape of a field
whose schema belongs to an agent or a manifest; normalize later only where a query needs it.

**Ids stay the 24-character ObjectId hex, stored as `text`**, for migrated rows and new ones
(`new ObjectId().toHexString()`), so every existing reference, URL, token and log line stays valid.

### D2. Callers reach storage through a repository
One module per aggregate under `backend/repositories/` exposes domain functions
(`findInstallation(agentName, instanceId, podId)`, `claimNextEvent(...)`), not a query builder. It
returns plain objects, so `.save()`, `.populate()` and virtuals stop at the boundary. When a model's
callers have all moved, a `no-restricted-imports` entry for it joins the `AgentPodReadCursor` one, so the
boundary holds.

### D3. Each model moves in four reversible steps
| Step | What | Rollback |
|---|---|---|
| 1. Extract | Callers move to the repository, which still reads and writes Mongo. No behaviour change. | Revert the PR. |
| 2. Dual | Writes go to both stores. Reads stay on Mongo, and a sample is read from Postgres too, compared, and any mismatch logged. A per-model mode (`mongo`, `dual`, `pg-read`, `pg`; default `mongo`) selects the step. A backfill copies history. | Mode to `mongo`. The next backfill discards the Postgres rows. |
| 3. Read cut | Reads come from Postgres; writes still go to both. | Mode to `dual`. Mongo is still complete. |
| 4. Drop | Mongo writes stop, and the Mongo code is deleted one release later. | Before deletion: mode to `dual` plus a reverse backfill that carries each row's `pg_version` into the document's version. After: restore from backup. |

**Mongo stays the system of record until step 4.** In `dual` and `pg-read`, a write commits to Mongo
first and is acknowledged only once it has; the Postgres write follows. **The repair marker travels in
the same Mongo write:** each write bumps a per-document version and sets `pgPending` to that version
(one document, so one atomic write). After the Postgres write succeeds, the marker is cleared with a
conditional update that matches that version, so an earlier write finishing late can never clear a later
write's marker. A crash between the two leaves the marker set, so nothing depends on recording the
failure after the fact. **A delete is two-phase:** it first marks the document deleted and pending in
Mongo, then deletes the Postgres row, and only then removes the Mongo document. A delete that crashes
halfway is therefore still a flagged document. A sparse index on `pgPending` makes the repair a cheap
scan: it re-copies each flagged document, or deletes its Postgres row if it is marked deleted, then
clears the marker the same conditional way. The dual-store helper's tests cover two writes interleaving,
and a delete crashing at each step. A failed Postgres write counts as a mismatch, and a model in `pg-read` goes back to `dual` while
any of its documents are flagged, including after a restart, until the repair finds none. Each replica
caches that check for up to 5 seconds, so after another replica's write fails a read can still come
from Postgres for that long. So rolling back
from `pg-read` to `dual` never loses an acknowledged write: Mongo has every one of them. In `pg` mode
an update or delete applies only to the row version it read, and re-reads on a lost race, so an update
racing a delete never brings the row back. A Postgres row at a version Mongo never wrote, which a
rollback from `pg` without carrying `pg_version` back would produce, counts as a `pg-ahead` mismatch and
keeps the document flagged, so reads stay on Mongo instead of serving the row.

Step 4 is the only one-way door, and it is taken per model. **A model reaches step 3 when the
`commonly verify` scenarios pass against both stores and the compare log shows zero unexplained
mismatches**, not after a fixed number of days.

### D4. No new Mongo model
Every collection added from now on is a Postgres table: a numbered file in `backend/config/migrations/`
and a repository. The three models added after the first count show the default runs the other way when
nothing stops it. `backend/__tests__/unit/models/mongoModelFreeze.test.js` lists the 70 names and fails
on a new one, on a file in `backend/models/` whose registration it cannot read, and on a
`mongoose.model(` or `new Schema(` anywhere else in production code. A removed model comes off the list
in the same PR, so the list only shrinks. A raw `connection.collection('…')` write is outside what the
test can see, so review catches that one.

### D5. One major per engine, changed on purpose
Postgres settles on 17 and Mongo on one major until it is removed. **A major change on a running
server is a data migration, not a tag edit**: Postgres needs `pg_upgrade` or a dump and restore, and
Mongo moves one major at a time with `featureCompatibilityVersion` set before each step. Each running
deployment's change is its own planned change with a backup taken first. Compose files and fresh installs
can move in an ordinary PR.

### D6. Order
**Wave 0, what is left.** Make Postgres required: the process entry refuses to start without
`PG_HOST` (`requirePgConfigured`, `server.ts`), so an instance without Postgres no longer runs with
no chat store. Message reads already come from Postgres alone once `PG_HOST` is set, so an instance
moving off the no-Postgres mode would hide its history until it is copied; boot logs how many chat
messages are still only in MongoDB, so an instance that skipped the backfill shows. The backfill
(`scripts/backfill-local-messages-to-pg.ts`) runs with the backend stopped, after one boot with
`PG_HOST` has applied the migrations (the script does not create tables), so no write or delete lands
in Mongo mid-copy; a self-host upgrade can take that window.

The backfill skips two kinds of row and says how many of each: rows whose pod is gone
(`orphanedPending`), and rows older than the message retention window in a pod that neither the Pro
tier nor `PG_RETENTION_EXEMPT_POD_IDS` protects (`expiredPending`), which the nightly retention run would
delete on arrival. Both stay in Mongo. The backfill applies the retention delete's own rule, read from
the same settings and measured by the Postgres clock. **The step is done on an instance when a report-only run, without `--since`, shows
`toCopy: 0`.** Measured on production 2026-11-02: 10,441 Mongo messages, none ever copied: 10,427 from before
August 2026, past retention unless their pod is protected, and 14 since. **Each instance runs it in
this order, staging first:** a report-only run; `--apply`; then `--verify`, which compares the copied
rows per pod by count and by a checksum over every column the copy writes (author kind and card payload
included), and exits 1 on any difference.
Production runs only after staging verifies clean.

The three self-creating tables move into a numbered migration, `0003_self_created_tables.sql`,
written to be a no-op on an instance that already has them. The dual-store helper
(`backend/repositories/dualStore.ts`) implements D3: the per-model mode (`STORE_MODE_<MODEL>`, default
`mongo`, which makes no Postgres call at all), the write-both with the versioned marker, the two-phase
delete, the repair scan and the sampled compare. Its unit tests run the interleavings on a real Mongo,
and the SQL runs on real Postgres in CI's integration job through the existing
`__tests__/utils/realPgSchema.js`, which already covers the jest-on-real-Postgres need named here.
**Moved to Wave 2:** the shared expiry sweeper. Its first consumer is Wave 2's TTL models; built now it
would have none, since the one self-created table with expiring rows, `message_claims`, already prunes
on every claim. **Still to do in Wave 0:** deleting the Mongo message code paths that only the
no-`PG_HOST` mode reached. Once the entry refuses that mode they run in no deployment, only in tests
that build the app without `PG_HOST`. They are deleted in their own change, because about 30 test
files exercise them and have to move to Postgres first.

**Waves 1 to 5** go from fewest callers to most, and lanes are split by caller-file overlap, because
step 1 is the only step that edits callers:

| Wave | Models | Note |
|---|---|---|
| 1 | 16 self-contained models with one owning service each (wake states, first-contact, billing events, needs-you email, GitHub gig, provider keys, onboarding episodes) | no populate, TTL or inbound refs; six parallel lanes |
| 2 | 18 TTL and small-populate models (OAuth and device state, webhook deliveries, asks, verdicts, invites, audit log, the scheduler lease) | needs the expiry sweeper; the lease becomes `INSERT … ON CONFLICT … WHERE expires_at < now()` |
| 3 | 12 agent-ops models (`AgentRun`, `AgentMemory`, `Task`, `Activity`, `DecisionRequest`, `AttentionItem`, `RoomGrant`, `Machine`, …) | `aggregate` calls become hand-written SQL, tested on real Postgres |
| 4 | 14 content and catalog models (`Post`, `Summary`, `PodAsset`, the `Installable` cluster, `AgentRegistry`) | `MediaObject` is a driver swap (ADR-002); `AgentRegistry.ts` is split first so `AgentInstallation` has its own file |
| 5 | `User`, `Pod`, `AgentInstallation`, `Integration`, `AgentEvent`, `AgentCredential` | callers overlap almost completely, so step 1 is one codemod per model, serial; the `pods`, `pod_members` and `users` copies are **replaced** by the real tables, never joined by a third copy |

The waves hold 66 models. `Message` leaves in Wave 0, and the three models added after the first count
join Wave 1, which accounts for all 70. The order inside Wave 5 is open.

### D7. FerretDB for self-host's Mongo layer: considered, not adopted (2026-11-05)
**Outcome.** Not adopted. Commonly ships no compose or Helm path for it, and a self-hoster shouldn't
pick it. FerretDB has had no release since v2.7.0 (2025-11-10). The DocumentDB project's own gateway
(`pg_documentdb_gw`) was named as an alternative, and that spike was stopped before it produced a
result. What follows records what was measured, in the present tense of that day.

FerretDB 2.7 (Apache-2.0) speaks the Mongo wire protocol and keeps the data in Postgres through
the DocumentDB extension (MIT). A self-hoster then runs Postgres alone: the chat tables and the
Mongo layer on one engine. Production stays on MongoDB.

**Measured.** The backend suite, run on both stores through the same harness (each suite gets its
own database on a real server; `TEST_MONGO_URI`, `.github/workflows/backend-ferretdb.yml`), at
`20c6bfb4` (main as of 2026-11-05 plus that harness, #3492), without the fixes below. CI run
42001537424; #3492 lists every suite:

| | Suites failing | Tests failing |
|---|---|---|
| MongoDB 7.0.14 | 0 of 925 | 0 of 11,228 |
| FerretDB 2.7.0 | 28 of 925 | 228 of 11,228 |

The failures traced so far fall into the groups below. #3492 labels 13 suites only by their first
error, and not all of those are traced yet:

1. **Collation.** FerretDB refuses collation on an update or an index and ignores it on a read
   without an error, so a case-insensitive label check passed a case-variant duplicate: a
   fail-open on the auth path. Fixed by lowercase key fields and a verified backfill (#3493, open).
2. **A partial index filtered with `$in`** is refused, and Mongoose only logs a failed index build,
   so the live-installation unique index silently stopped refusing. Fixed by a boolean `live`
   field (#3491, open).
3. **Racing upserts** come back as E11000, a Postgres deadlock, or for `findOneAndUpdate` a code-1
   error, where MongoDB retries internally; 20 racing `$inc` upserts ended at 7 to 19. Fixed by a
   retry on FerretDB only (#3495, open) and one `isDuplicateKeyError` that recognises both the
   E11000 and the code-1 constraint forms (not deadlocks, which only the retry handles). Concurrent writers
   that don't upsert can still hit a Postgres deadlock (the decision-card reply bridges, GitHub
   repository connect, the needs-you email); those are open, and a retry on deadlock is the likely
   shape.
4. **A query-plan assertion** (`IXSCAN`) that reads MongoDB's explain output. Store-specific by nature.

Also unsupported, and unused today: change streams, `commitTransaction`. A `listIndexes` on a
missing collection errors. The rest of what Commonly leans on behaves the same: atomic
`findOneAndUpdate` claims, `$inc`, TTL indexes, partial indexes on equality and `$exists`, `$text`,
`$lookup`, pipeline updates, `arrayFilters`, majority write concern.

**Rules proposed for new Mongo-layer code, which don't bind now that D7 isn't adopted:** no collation, no `$in` (or other
operator) in a partial index filter, and every check for a lost race goes through
`isDuplicateKeyError`. A known gap: existing refusals that read `keyPattern` (signup, username
change and a few others) still surface a code-1 refusal as a 500 on FerretDB (#3495 lists them). The
The FerretDB CI workflow (#3492) was removed when D7 was not adopted.

**Constraints.** The DocumentDB extension needs a superuser and `shared_preload_libraries`
(`pg_cron`, `documentdb`), so it runs on a Postgres the instance owns, not on a managed one. The
`ferretdb/postgres-documentdb` image also bundles PostGIS (GPL-2.0-or-later). Commonly references
that image by tag only in that CI workflow and did not redistribute it. Compose and Helm
support is not built yet; when it lands it references the image the same way, and a self-hoster
pulls it from its publisher.

**Auth hot path** (CI bench `backend/__tests__/bench/authHotPath.bench.js`: 5,000 users, 2,000 pods,
3,000 timed runs after 200 warm-up, the same three hand-built indexes on both stores, each store on
its own runner, CI run 42005958108, ms). At this size every row is in cache, so this is the round
trip, not a cold read:

| Query | FerretDB p50 / p95 / p99 | MongoDB p50 / p95 / p99 |
|---|---|---|
| Session account read (auth middleware) | 1.03 / 1.30 / 1.94 | 0.75 / 1.00 / 1.60 |
| `lastActive` write (auth middleware) | 1.53 / 1.94 / 3.74 | 0.69 / 0.89 / 1.24 |
| Pods for a member (pod list) | 0.97 / 1.16 / 1.73 | 0.63 / 0.79 / 1.35 |
| User by username (login) | 0.94 / 1.07 / 1.70 | 0.63 / 0.69 / 0.90 |

FerretDB adds about 0.3 to 1 ms at p95 per query, the write the most: inside a request's budget for
a self-hosted instance, and the reason production stays on MongoDB until the Postgres port.

**Clean-install walk, 2026-11-05.** The local compose profile with the unmerged FerretDB override
reached sign-up, pods and messages. A bring-your-own agent failed at attach, because issuing a
runtime token writes with a collation (`update.updates.collation` is not supported). With the unmerged
fixes applied (#3491, #3493, #3495 on #3506), Claude Code answered an @mention. None of those PRs
was merged for this decision.

## Risks
- **Copy drift is a bug we already have.** The Postgres `pods`, `pod_members` and `users` rows are synced
  by hand from Mongo (`services/pgPodSyncService.ts` and its callers). Wave 5 removes the copies.
- **Claims and leases.** Port each `findOneAndUpdate` claim as `UPDATE … RETURNING` or
  `FOR UPDATE SKIP LOCKED`, and test the losing claimant on real Postgres. A transaction where Mongo had
  none is allowed, and it is written down when it happens.
- **TTL.** Postgres has no TTL index. The sweeper lags, so every read of an expiring row also filters
  `expires_at > now()`.
- **Document size.** JSONB values above about 2 KB are stored out of line, so a large `AgentRun.result`
  slows reads long before it fails. Cap it at write.
- **ObjectId semantics.** Code that sorts by `_id`, reads `.getTimestamp()`, or compares `ObjectId`
  instances breaks on text ids. Step 1 greps each model's callers for these.
- **Hot paths.** `User`, `Pod`, `AgentInstallation` and `AgentCredential` sit under `middleware/auth` and
  `agentRuntimeAuth`; a slower query there slows every request. Measure p95 at step 3.

## Effort (a 2026-10-25 estimate)
About **85 to 105 agent-days**, roughly 8 to 10 calendar weeks with parallel lanes in Waves 1 to 4. It
prices dual writes, comparison, backfill and moving the tests (475 test files import a model; 54 start
`mongodb-memory-server` directly and 47 use `pg-mem`). Parallel lanes shorten Waves 1 to 4. They do
not shorten the scenario runs at each read cut, and they barely help Wave 5, where callers overlap.
