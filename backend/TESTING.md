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
