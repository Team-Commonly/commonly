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

## Node 26 kills any suite whose require graph reaches `buffer-equal-constant-time`

Node 26 removed `SlowBuffer`. `buffer-equal-constant-time/index.js:37` reads
`SlowBuffer.prototype.equal` at **module scope**, so it throws the moment it is
required — before any test runs:

```
TypeError: Cannot read properties of undefined (reading 'prototype')
    at Object.<anonymous> (backend/node_modules/buffer-equal-constant-time/index.js:37:35)
```

The line one might expect to be at fault, `Buffer.prototype.equal =
SlowBuffer.prototype.equal = …` at `:31`, sits inside `bufferEq.install` and
never runs. The unconditional **read** at `:37` is the one that fires.

**`jsonwebtoken` is the common importer, not the failing package.** The chain is
`jsonwebtoken` → `jws` → `jwa` → `buffer-equal-constant-time`, and both
`require('jsonwebtoken')` and `require('buffer-equal-constant-time')` throw at
the identical frame. So a "will this suite die on 26?" check must ask whether
that leaf is in the require graph — grepping a suite for the string
`jsonwebtoken` misses every suite that reaches it transitively, and blames the
wrong package when it hits.

It fails **loudly**: `Tests: 0 total` and a non-zero exit, never a silent skip.
A red suite here is an environment artifact and not a defect in the change under
test — do not "fix" a PR against it.

**Upgrading escapes nothing** (@sprint-review), which is the first thing anyone
tries. Measured against the registry 2026-08-25:

| package | latest | what it pins |
|---|---|---|
| `jsonwebtoken` | 9.0.3 | `jws ^4` |
| `jws` | 4.0.1 | `jwa ^2.0.1` |
| `jwa` | 2.0.1 | `buffer-equal-constant-time ^1.0.1` |
| `buffer-equal-constant-time` | **1.0.1** | nothing — zero deps |

The leaf is at its latest published version *and* that version is the one that
breaks, so the whole chain resolves onto it even fully upgraded. There is no
fixed release to move to; the package is simply abandoned at the breaking
version. Don't spend an afternoon on `npm update`.

**Abandoned is not unfixable, though** (@sprint-review). "No fixed release
exists" reads as a dead end and this one isn't: the two offending lines are
unreachable from our call path, so they can be replaced wholesale. `jwa`
imports the package at `index.js:1` and uses it in exactly one place —
`index.js:141`, the plain `bufferEqual(a, b)` comparison — and `.install()` /
`.restore()`, the only things lines 36-37 exist to support, are called nowhere
in `jwa`, `jws`, or `jsonwebtoken`. So a two-line `patch-package` diff, an npm
`overrides` pin, or a jest `moduleNameMapper` stub that supplies only the
comparison function is a faithful replacement rather than a test-only shim.
Note that is a stub of the *leaf*, not of `jsonwebtoken` — the caution below
about stubbing `jsonwebtoken` doesn't apply, because real signing and verifying
still run against a real comparison.
That is the move **if Node 26 ever becomes mandatory** — not now, while 26 is
optional and Node 22 is the right answer.

Note the remedy has to intercept the `require`. Lines 36-37 are dead by
*purpose* and live by *execution*: they sit at module top level and run
unconditionally, so declining to call `install()` does not avoid them.

The leaf is also the tree's only casualty. Sixteen packages under
`backend/node_modules` mention `SlowBuffer`; the six that could plausibly touch
it at runtime — `safe-buffer`, `safer-buffer`, `object-hash`, `iconv-lite`,
`string_decoder`, `readable-stream` — all `require` clean on 26 (they guard the
reference). The rest are type declarations, browser bundles, and changelogs.
One patch covers the whole backend.

Fix: run on the version CI uses. `tests.yml` pins **Node 22**.

```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH npx jest <suite>
```

Prefer that over `--moduleNameMapper` stubbing of `jsonwebtoken`: a stub works
for suites that only import it transitively and silently breaks any suite that
actually signs or verifies a token, which is most of the runtime-token service
suites.

Suites with no jwt in their graph are unaffected — `mongoose` and
`mongodb-memory-server` both load clean on 26.

## CI

`.github/workflows/tests.yml` defines both tiers:

- `test` job → Tier 0 (unit + coverage) on every push
- `service-test` job → Tier 1 with `mongo:7` and `postgres:16` service containers, depends on `test`

Both are required checks on `main` via branch protection.
