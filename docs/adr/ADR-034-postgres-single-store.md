# ADR-034: Postgres is the single data store

**Status:** **Accepted** 2026-11-02 as the direction. The project's founder set it on 2026-10-25:
Mongo plus Postgres makes self-hosting hard, so the target is Postgres only. **Accepting the
direction does not settle three things, and each is named where it lives:** the effort estimate
(Effort is a 10-25 estimate, not a commitment), the order inside Wave 5 (D6), and the size of the
mismatch log that a read cut may tolerate (D3 sets it at zero unexplained mismatches, which may prove
too strict for models with clock-derived fields).

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
| 4. Drop | Mongo writes stop, and the Mongo code is deleted one release later. | Before deletion: mode to `dual` plus a reverse backfill. After: restore from backup. |

**Mongo stays the system of record until step 4.** In `dual` and `pg-read`, a write commits to Mongo
first and is acknowledged only once it has; the Postgres write follows. **The repair marker travels in
the same Mongo write:** the document carries a `pgPending` flag set by that write (one document, so one
atomic write), and the flag is cleared only after the Postgres write succeeds. A crash between the two
leaves the flag set, so nothing depends on recording the failure after the fact. A sparse index on
`pgPending` makes the repair a cheap scan: it re-copies each flagged document (idempotently) and clears
the flag. A failed Postgres write counts as a mismatch, and a model in `pg-read` goes back to `dual` while
any of its documents are flagged, including after a restart, until the repair finds none. So rolling back
from `pg-read` to `dual` never loses an acknowledged write: Mongo has every one of them.

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
**Wave 0, what is left.** Make Postgres required: remove the no-`PG_HOST` message mode, so an instance
without Postgres refuses to boot instead of running degraded, and Mongo `Message` keeps only the history
the backfill copies. Message reads come from Postgres alone once `PG_HOST` is set, so an instance moving
off that mode would hide its history until it is copied. The step is done on an instance only when
a report-only run of `scripts/backfill-local-messages-to-pg.ts`, without `--since` so no older history
is out of scope, shows `pending` equal to `orphanedPending`. That means every pending row left belongs to a
deleted pod and stays in Mongo by design. The release that removes the mode says so in its upgrade
note, and boot logs the pending count, so an instance that skipped the backfill shows. Move the three self-creating tables into numbered migrations. Build the dual-store helper (D3's mode,
write-both, sampled compare), a shared expiry sweeper for TTL models, and a jest helper on real
Postgres for anything with claims or SQL aggregates (`ToolCall.ts` already records that `pg-mem`
cannot run a correlated `EXISTS`).

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
