# Run the Mongo layer on FerretDB (one engine: Postgres)

Commonly keeps documents in MongoDB and chat in Postgres. A self-hosted instance can
instead serve the Mongo layer with [FerretDB](https://www.ferretdb.com/) 2.7, which speaks
the Mongo wire protocol and stores the documents in Postgres through the DocumentDB
extension. Then you run one database engine, Postgres, for everything. The backend code
doesn't change: it still talks to Mongoose. Production (commonly.me) stays on MongoDB.

The decision and measurements are in ADR-034 D7 (#3503), and the CI leg that runs the backend
suite on FerretDB is #3492. Both are open: until they merge, read them on their PRs.

## When to pick it

- **Pick it** if you already run and back up Postgres and don't want to run MongoDB as well,
  or if MongoDB's SSPL licence is a problem for you.
- **Stay on MongoDB** (the default) if you want the path production runs, the full test
  suite green, and the existing backup job. FerretDB adds about 0.3 to 1 ms at p95 per
  query on the auth hot path (ADR-034 D7). That's fine for a small instance, but it isn't free.

## Commonly version required

**FerretDB needs #3491, #3493 and #3495.** Until all three have merged, a FerretDB
instance behaves wrongly in ways you won't see:
- **#3493:** a case-variant duplicate username gets through, because FerretDB ignores collation.
- **#3491:** the one-live-install-per-target index doesn't build.
- **#3495:** racing upserts fail instead of retrying.

Use a Commonly build that includes all three. The upsert retry turns itself on when the
backend detects FerretDB (`buildInfo`). `MONGO_UPSERT_RETRY` overrides that detection.

**After upgrading an existing instance to a build with the fixes**, run both backfills
once the rollout has finished. Both are idempotent:

```bash
# compose (local profile; the image carries the compiled scripts)
docker compose --env-file .env -f docker-compose.local.yml -f docker-compose.ferretdb.yml \
  exec backend npm run backfill:user-label-keys -- --apply --verify
docker compose --env-file .env -f docker-compose.local.yml -f docker-compose.ferretdb.yml \
  exec backend npm run backfill:installation-live -- --apply --verify
```

On Kubernetes, run the same two `npm run ... -- --apply --verify` commands in the
ops-runner pod, never in the serving backend. Each run exits 0 only when its verify passes.

## Docker Compose

`docker-compose.ferretdb.yml` is an override:
- The `postgres` service becomes Postgres with the DocumentDB extension.
- The `mongo` service becomes FerretDB in front of it.
- The backend's `MONGO_URI` and `PG_*` point at them.

Chat gets its own database (`PG_DATABASE`, default `commonly`) on the same server. You
need Docker Compose 2.24.4 or later.

```bash
# development stack
docker compose -f docker-compose.yml -f docker-compose.ferretdb.yml up

# the one-command local profile (what ./install.sh runs)
./install.sh   # once, to create .env; then switch:
docker compose --env-file .env -f docker-compose.local.yml -f docker-compose.ferretdb.yml up -d --build
```

- **Credentials:** FerretDB signs clients in with the Postgres superuser, which is
  `PG_USER` (default `postgres`) with `PG_PASSWORD`. Both go into URLs, so use letters,
  digits and `- _ . ~` only. The passwords `install.sh` generates are hex.
- **Data:** the override uses a new volume, `documentdb-data`. Switching an existing
  install doesn't move its data. Your old `mongo-data` and `postgres-data` volumes are
  left alone.
- **Telemetry:** the override turns FerretDB's telemetry off (`FERRETDB_TELEMETRY=disable`).

## Helm

Set `mongodb.engine: ferretdb` (the default is `mongodb`). In place of the mongodb
StatefulSet, the chart renders:
- the StatefulSet and headless Service `documentdb`;
- the Deployment and Service `ferretdb`;
- the `documentdb-init` ConfigMap, which creates the chat database.

The documentdb superuser is `postgresql.username`, with the `postgres-password` key of
`database-credentials`.

```yaml
mongodb:
  enabled: true
  engine: ferretdb
  ferretdb:
    documentdb:
      persistence:
        storageClass: standard   # your cluster's storage class
        size: 20Gi

# Optional, for one engine: put chat on the same server instead of the postgres StatefulSet.
postgresql:
  enabled: false
backend:
  env:
    pgHost: documentdb.<namespace>.svc.cluster.local
    pgUser: postgres          # = postgresql.username, the documentdb superuser
    pgDatabase: commonly      # = postgresql.database, created on first init
    pgSslEnabled: "false"
```

- **With `externalSecrets.enabled: false`:** the chart builds `mongo-uri` itself, as
  `mongodb://<postgresql.username>:<localSecrets.postgresPassword>@ferretdb.<ns>.svc.cluster.local:27017/commonly`.
- **With external secrets:** store that URI under your `mongo-uri` key yourself.
- Keep the password URL-safe, because FerretDB's connection string embeds it.

Image tags, resources and persistence live under `mongodb.ferretdb` in
[`values.yaml`](../../k8s/helm/commonly/values.yaml). The rest of the chart's values are
covered in the [Helm values reference](helm-reference.md).

## Constraints

- **You need a Postgres you own; managed Postgres won't work.** The DocumentDB extension
  needs a superuser and `shared_preload_libraries` (`pg_cron`, `documentdb`). The image
  sets both on first init. No managed Postgres service offers the DocumentDB extension or a
  real superuser (some allow `pg_cron`), so neither the Compose override nor the chart can
  use one.
- **The DocumentDB extension lives in the `postgres` database.** pg_cron's
  `cron.database_name` is `postgres`, so leave `POSTGRES_DB` alone. Chat uses its own
  database.
- **Licences.** FerretDB is Apache-2.0 and the DocumentDB extension is MIT. The
  `ghcr.io/ferretdb/postgres-documentdb` image also bundles PostGIS, which is
  GPL-2.0-or-later. Commonly refers to that image by tag only, and Docker or Kubernetes
  pulls it from its publisher. Commonly doesn't redistribute it. Check that this fits
  your own distribution terms.

## Known gaps

- **Deadlocks in some writers that don't upsert.** Concurrent writes in the decision-card
  reply bridges, GitHub repository connect and the needs-you email can still hit a Postgres
  deadlock. The upsert retry doesn't cover them.
- **A few signup and rename refusals return 500 instead of 409.** Some existing refusals
  read `keyPattern` and surface FerretDB's code-1 duplicate as a 500. #3495 lists them.
- **Some failing suites aren't traced yet.** The FerretDB CI leg (#3492) isn't green. Some
  of its failing suites haven't been traced to a cause.
- **No Postgres backup job for this layout.** The chart's mongodb backup CronJob doesn't
  render under `engine: ferretdb`, because `mongodump` against FerretDB is untested. The
  postgres backup CronJob dumps `backend.env.pgDatabase` only: with the one-engine values
  above that is the chat database, never the `postgres` database that holds the documents.
  A green `postgres-backup` does not mean the documents are backed up. Back up the
  documentdb Postgres yourself, for example with `pg_dumpall` or a volume snapshot.
- **Not supported, and unused today:** change streams and multi-document transactions.
