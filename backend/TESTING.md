# Backend Testing Guide

This guide describes the two backend test tiers introduced by **[ADR-009](../docs/adr/ADR-009-test-tiers-and-ci-cd-to-gke.md)** (Phase 1) and how each runs locally and in CI.

## Tiers at a glance

| Tier | Location | What it exercises | `INTEGRATION_TEST` | Runs on |
|---|---|---|---|---|
| **0 — Unit** | `__tests__/unit/`, `__tests__/services/`, route-handler tests with mocks | In-memory / mocked everything | unset | every push (CI job `Test & Coverage`) |
| **1 — Service** | `__tests__/service/` | Real MongoDB + PostgreSQL from service containers | `true` | every push (CI job `Service Tests (Tier 1 — real DBs)`) |

Higher tiers (1.5 chart-lint, 2 cluster smoke, 3 dev-env smoke) are out of scope for this doc — see ADR-009.

## Tier 0 — Unit

Default mode. `setupMongoDb()` spins up `MongoMemoryServer`; `setupPgDb()` uses `pg-mem`. No network, no ports, no containers. Everything under `__tests__/unit/`, `__tests__/services/`, and route-handler tests that mock their DB models falls here.

```bash
cd backend && npm test
cd backend && npm run test:coverage
cd backend && npm run test:watch
npm test -- registry.runtime-tokens.test.js        # single file
```

## Tier 1 — Service (real DBs)

Everything under `__tests__/service/`. When `INTEGRATION_TEST=true` is set, `__tests__/setup.js` populates `MONGO_URI` / `PG_*` defaults and `testUtils.js` connects to the real Mongo / Postgres instead of the in-memory servers. Same test bodies, same assertions — only the DB layer changes.

Run locally against Docker Compose:

```bash
./dev.sh up                        # boots mongo:27017 and postgres:5432
./dev.sh test:integration          # INTEGRATION_TEST=true npm --prefix backend test
```

Run only the service directory (matches CI):

```bash
cd backend && INTEGRATION_TEST=true \
  MONGO_URI=mongodb://localhost:27017/commonly-test \
  PG_HOST=localhost PG_PORT=5432 PG_DATABASE=commonly-test \
  PG_USER=postgres PG_PASSWORD=postgres PG_SSL_ENABLED=false \
  npx jest --testPathPattern="__tests__/service" --forceExit --runInBand
```

Schema source: `backend/config/schema.sql`. `testUtils.setupPgDb()` applies it verbatim after `CREATE EXTENSION IF NOT EXISTS pgcrypto`.

> **Blind spot both tiers share: neither exercises an EXISTING database.**
> Tier 1 provisions a fresh `postgres:16` per CI run, so `CREATE TABLE IF NOT
> EXISTS` always takes the CREATE branch. Tier 0 reads `schema.sql` as text.
> A column added to an existing table therefore needs a *third* arrangement to
> be tested at all: start from the pre-threading table shape, apply the
> retrofit `ALTER`s, assert the column appears. See
> `__tests__/unit/models/threadingSchemaRetrofit.test.js`.
>
> This is not hypothetical. On 2026-08-22 `thread_root_id` shipped declared
> only inside its `CREATE TABLE`; both tiers were green and the column would
> never have existed on the live instance, throwing at boot on the index and
> failing every INSERT that named it. Any PR adding a column to an existing
> table should be read for both declarations.

Tier-1 setup logs `[tier1] Connected to real MongoDB …` and `[tier1] Connected to real Postgres …` so the CI run log makes the mode obvious.

## Test helpers (`__tests__/utils/testUtils.js`)

| Helper | Tier 0 behavior | Tier 1 behavior |
|---|---|---|
| `setupMongoDb()` | `MongoMemoryServer.create` + `mongoose.connect` | `mongoose.connect(process.env.MONGO_URI)` |
| `closeMongoDb()` | disconnect + stop memory server | disconnect |
| `clearMongoDb()` | `deleteMany({})` per collection | same |
| `setupPgDb()` | `pg-mem` + hand-crafted pods/pod_members/messages tables | `new pg.Pool(...)` + `pgcrypto` + apply `schema.sql` |
| `clearPgDb()` | ordered `DELETE FROM` | `TRUNCATE … RESTART IDENTITY CASCADE` |
| `closePgDb()` | `pool.end()` | `pool.end()` |
| `generateTestToken(userId)` | signs with `process.env.JWT_SECRET` | same |
| `createTestUser / Pod / Message` | Mongoose model instantiation | same |

The branch is controlled by `process.env.INTEGRATION_TEST === 'true'`. `__tests__/setup.js` reads this at suite start and populates `MONGO_URI` / `PG_*` defaults when set; when unset, it nulls them so accidental real-DB connections fail loudly.

## Authoring rules

- **Tier 0 tests don't cross-import `mongoServer` / `pgDb`.** The real-services branch doesn't export them. Use the helpers; if you need direct access, add a narrow helper in `testUtils.js` that works in both tiers.
- **Real PG needs `pgcrypto` for `gen_random_uuid()`.** `setupPgDb` creates the extension for Tier 1 — don't call `gen_random_uuid()` in a test that only runs under Tier 0 unless you're also registering the pg-mem function.
- **pg-mem applies SELF-REFERENTIAL FK actions to the primary-key index and not to the row storage, so the answer depends on your query plan.** The DDL is accepted in every case. Measured on pg-mem 2.9.1 and pinned in `__tests__/unit/models/pgMemFkActionFidelity.test.js`:

  | constraint | pg-mem |
  |---|---|
  | cross-table `ON DELETE CASCADE` | fires — matches Postgres |
  | cross-table `ON DELETE SET NULL` | fires — matches Postgres |
  | self-referential `ON DELETE CASCADE` | **contradicts itself** — the row is gone via the PK index, still present to a scan |
  | self-referential `ON DELETE SET NULL` | **contradicts itself** — the FK reads `NULL` via the PK index, unchanged to a scan |
  | `ON DELETE SET DEFAULT` | sets **NULL**, not the column default |
  | insert violating the FK | rejected |
  | delete violating the default `NO ACTION` | rejected |

  "Contradicts itself" is literal — one table, one transaction, two answers for the same row. Given `m(id INT PRIMARY KEY, p INT REFERENCES m(id) ON DELETE SET NULL)` seeded `(1,NULL),(2,1),(3,2)` and `DELETE FROM m WHERE id = 1`:

  ```
  SELECT * FROM m ORDER BY id      → [{id:2,p:1},{id:3,p:2}]   -- action NOT applied
  SELECT * FROM m WHERE id = 2     → [{id:2,p:null}]           -- action applied
  SELECT * FROM m WHERE p = 1      → [{id:2,p:1}]              -- matches the stale value
  SELECT * FROM m WHERE p IS NULL  → []                        -- and not the applied one
  ```

  Under `CASCADE` the same split deletes row 2 from the PK index while `SELECT *` and `count(*)` still report two rows. A plan served by the PK index sees the action; a plan that scans sees the pre-delete value. `p` carries no index, so predicates on the FK column always read stale.

  The variable is isolated by disabling the index in place — same predicate, same rows, nothing else changed:

  ```
  WHERE id = 10      (pk index) -> parent_id = null
  WHERE id + 0 = 10  (no index) -> parent_id = 1
  ```

  The line is index *eligibility*, not equality: `>=` and `IN` are index-served too and agree with the first reading.

  **This is worse than the "pg-mem ignores them" reading it replaces** (which is what an earlier version of this rule and the first draft of that suite both said). Ignoring is at least consistent: every read agrees, and a test that passes does so for one knowable reason. Here the *shape of the assertion query* picks the answer — `expect(rows(db, 'SELECT * FROM m'))` and `expect(rows(db, 'SELECT * FROM m WHERE id = 2'))` disagree about whether the constraint fired, and both look like a real result. A green Tier 0 constraint test is therefore not evidence even of pg-mem's own behaviour, let alone Postgres's.

  `messages` has both shapes. `messages.pod_id → pods(id)` and `thread_user_state.thread_root_id → messages(id)` are cross-table and genuinely covered at Tier 0. `messages.reply_to_message_id` and `messages.thread_root_id` point back at `messages(id)`, so **a Tier 0 test that deletes a message and asserts what became of its descendants is asserting nothing** — it reports whichever answer its own `SELECT` happened to reach. One such test was written, passed, and was deleted rather than kept (`__tests__/unit/models/retentionReRoot.test.js` records it).

  The general rule: **pg-mem proves SQL *shape*; only Tier 1 proves the database's *behaviour*.** A constraint whose effect you are asserting belongs in `__tests__/service/`. Split it the way `retentionReRoot.test.js` (repair, given a constructed orphaned state) and `__tests__/service/threading.retention.test.js` (that Postgres produces that state at all) do — a claim about our code at Tier 0, a claim about the database at Tier 1.

  `pgMemFkActionFidelity.test.js` asserts the *dependency's* current behaviour on purpose. If a pg-mem bump starts honouring these, that suite goes red — the signal to delete it and this rule, not to relax the assertion.

- **FK ordering matters under real PG.** `pod_members.pod_id` and `messages.pod_id` reference `pods(id) ON DELETE CASCADE`. Tests that insert raw rows must insert into `pods` first. `clearPgDb()` uses `TRUNCATE … CASCADE` to sidestep this on teardown.
- **Timeouts.** Real Mongo operations are slower than in-memory. `jest.setTimeout(30000)` is set globally in `__tests__/setup.js`; avoid hardcoded shorter timeouts in Tier 1 tests.
- **New test file, which tier?** Put it under `__tests__/service/` if it exercises real query semantics (Mongo index behavior, regex, ObjectId coercion, PG ILIKE, transactions). Put it under `__tests__/unit/` or similar if a mocked DB is sufficient.

## Frontend and other suites

Frontend testing is documented separately at `frontend/TESTING.md`. Contracts tests (`__tests__/contracts/`) are Tier 0 by default and use provider mocks.

## Docker-based runs

```bash
./dev.sh test                   # Tier 0 in backend container
./dev.sh shell backend          # interactive shell; run `npm test` inside
./dev.sh test:integration       # Tier 1 against Docker Compose services (./dev.sh up required)
```

## CI

`.github/workflows/tests.yml` defines both tiers:

- `test` job → Tier 0 (unit + coverage) on every push
- `service-test` job → Tier 1 with `mongo:7` and `postgres:16` service containers, depends on `test`

Both are required checks on `main` via branch protection.
