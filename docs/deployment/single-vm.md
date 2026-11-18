# Single-VM production deployment

Commonly can run on one Debian VM with Docker Compose, using the same backend
and frontend images the Helm chart deploys. The files are in `deploy/vm/`:

| File | What it is |
|------|------------|
| `docker-compose.yml` | The stack. Images are pulled by tag, and no host port is published. |
| `.env.example` | Stack settings: image tag, Postgres roles, tunnel token, backup bucket. Used only to fill `${...}` in the compose file. |
| `backend.env.example`, `litellm.env.example`, `commonly-bot.env.example`, `backup.env.example` | Each service's own env, as names only. |
| `render-env-from-k8s.sh` | Writes `backend.env`, `litellm.env`, `commonly-bot.env` and `backup.env` from the Deployments running in a cluster, and copies commonly-bot's accounts file. |
| `backup.sh` | The nightly backup loop the `pg-backup` service runs. |
| `postgres-init/10-roles.sh` | Creates the app and LiteLLM roles when the database is first created. |

Each service sees only its own env file and the names the compose file hands it.
The tunnel token goes only to `cloudflared`, and the bucket keys only to
`pg-backup`. All five env files and `commonly-bot-state/` are git-ignored. Keep
the files at mode 0600.

`backend/__tests__/unit/deployment/singleVmCompose.test.js` fails in three cases:

- The chart gains a backend, LiteLLM or commonly-bot env var that is not in the example, not a
  compose override, and not excluded with a reason.
- A compose override drifts from the chart's value without a stated reason.
- The quoting of the rendered files stops round-tripping through `docker compose`.

## What runs

| Service | Image | Notes |
|---------|-------|-------|
| `backend` | `commonly-backend:<tag>` | One container, web and worker together (`RUN_WORKER` unset). Health is `/api/health`. |
| `frontend` | `commonly-frontend:<tag>` | The prod nginx image, serving static files only. |
| `postgres` | `postgres:16.15-alpine3.24` | Chat, the PG mirror, and LiteLLM's `litellm` schema, in the `postgres-data` volume. |
| `litellm` | `ghcr.io/berriai/litellm:v1.106.2` | The chart's config, rendered on each deploy. |
| `commonly-bot` | `commonly-bot:<tag>` | The summarizer agent. It polls the backend with the tokens in `commonly-bot-state/runtime.json`. |
| `cloudflared` | `cloudflare/cloudflared:2026.1.2` | The only way in: a remotely managed tunnel, run from `TUNNEL_TOKEN`. |
| `pg-backup` | the postgres image | Nightly `pg_dump -Fc` and `mongodump` to an R2 bucket, keeping 14 days. |

MongoDB is not on the VM. The backend and the backups reach it by its URI.

### Start order

- `postgres` must be healthy before `backend` and `litellm` start.
- `backend` and `commonly-bot` wait for LiteLLM's readiness (`/health/readiness`), so a model call never meets a LiteLLM that isn't listening yet. That wait is optional (`required: false`). If LiteLLM never gets healthy, compose prints `optional dependency "litellm" failed to start` and starts them anyway. A broken LiteLLM costs model calls, but the backend still starts. `up -d --wait` still exits non-zero, because LiteLLM is a service in the project.
- This order holds only for `docker compose up`. After a VM reboot, the Docker daemon restarts the containers by their restart policy and knows nothing of `depends_on`, so the backend can come up first. Until LiteLLM is listening, a model call fails with `ECONNREFUSED litellm:4000`.

### commonly-bot's accounts file

`commonly-bot-state/runtime.json` lists the bot's accounts, one per installed
instance, each with its runtime token and user token. Treat it as a secret. In
the cluster it is the `commonly-bot-config` ConfigMap. On the VM it is a file in
`deploy/vm/commonly-bot-state/`, mounted read-write into the backend and
read-only into the bot:

- The backend writes it whenever the bot's agent is installed into a pod or
  reprovisioned, including `reprovision-all`. With Kubernetes provisioning off,
  the provisioner writes `COMMONLY_BOT_CONFIG_PATH` instead of the ConfigMap.
- The bot re-reads it on every poll, so a new account starts working without a
  restart.
- Scale the cluster's `commonly-bot` Deployment to zero at cutover. While both
  run against the same Mongo, both poll the same accounts.
- The backups do not cover it. Keep a copy of the rendered file in the same
  private place as the env files.
- The backend writes the file as root and chowns it to uid 1000. The directory
  stays 0700, so only that user and root can read it.

Configure the tunnel's public hostnames on the Cloudflare side:

- `commonly.me` goes to `http://frontend:80`.
- `api.commonly.me` goes to `http://backend:5000`.
- If LiteLLM is served publicly, `litellm.<domain>` goes to `http://litellm:4000`, limited to the `/v1` path. The admin UI must stay unrouted.

### Differences from GKE

- **No staging, no HA.** There is one VM and one backend. A deploy restarts the
  backend, so expect a gap of about a minute.
- **No Redis.** The backend uses Redis only when Kubernetes agent provisioning
  is on. With one process, every socket lives in that process.
- **The Kubernetes-only features are off.** These are agent provisioning into
  pods (cloud-codex, gateway agents), the agent computer, the hosted sandbox,
  the ChatGPT account rotator and Codex CLI sidecar on LiteLLM, the ops-runner
  pod, the stranger-journey CronJob and the cluster alerting. Each example file
  lists the env vars left out and why.
- **Postgres is local.** It runs on the compose network with no TLS and no
  published port.
- **No ingress request-size cap.** ingress-nginx refused bodies over 10 MB, and
  Cloudflare passes larger ones up to its plan limit. The backend still sets its
  own limits: JSON bodies use express's 100 KB default, the grant push route
  allows 9 MB, and uploads are capped by the object store's `maxObjectBytes`
  (10 MiB on the Mongo store). A new route that buffers a body needs its own
  limit.
- **The same `NODE_ENV` as today.** The compose file sets the value the chart's
  dev values run (`development`), and the test pins the two together.

## First setup

1. **Create the VM** with no public SSH. Allow port 22 only from Google's IAP
   range (`35.235.240.0/20`) and connect with
   `gcloud compute ssh <vm> --tunnel-through-iap`. The VM needs no inbound
   ports, because the tunnel dials out.
2. **Install Docker Engine and the compose plugin** from Docker's apt
   repository for Debian (docs.docker.com/engine/install/debian). Add the deploy
   user to the `docker` group. `docker compose version` must print v2.20 or
   later, which is the first version that reads `required` in `depends_on`.
3. **Check out the repo** at the SHA you will deploy. The compose file mounts the
   chart's LiteLLM files and marketplace manifest from the checkout.

   ```bash
   git clone https://github.com/Team-Commonly/commonly.git /opt/commonly
   cd /opt/commonly && git checkout <sha>
   ```
4. **Write the env files.**

   - **Migrating from the cluster.** On a machine with kubectl access, render
     the service files from the running Deployments. The script resolves every
     literal, Secret and ConfigMap reference, keeps only the names in each
     example, and writes the files at 0600. It prints counts, never values; add
     `--list-names` to see which names were skipped.

     ```bash
     deploy/vm/render-env-from-k8s.sh --context <kube-context> --namespace <namespace> --out-dir <private dir>
     gcloud compute scp --tunnel-through-iap --scp-flag=-p <private dir>/{backend,litellm,commonly-bot,backup}.env <vm>:/opt/commonly/deploy/vm/
     gcloud compute scp --tunnel-through-iap --scp-flag=-p --recurse <private dir>/commonly-bot-state <vm>:/opt/commonly/deploy/vm/
     # on the VM:
     chmod 600 /opt/commonly/deploy/vm/*.env /opt/commonly/deploy/vm/commonly-bot-state/runtime.json
     chmod 700 /opt/commonly/deploy/vm/commonly-bot-state
     ```

     Delete the local copies afterwards. A value the script can't quote safely is
     counted as "not representable", which means a backslash right before a
     quote or at the end. Add those by hand.
   - **Fresh install.** Copy each `*.env.example` to its `.env` name, fill it by
     hand, and `chmod 600`. Each example says which values must match the
     chart's defaults. Create `commonly-bot-state/` at 0700 and leave it empty:
     the backend writes `runtime.json` when the bot's agent is first installed,
     and the bot waits until then.
   - **Either way, fill `.env` by hand** from `.env.example`, at mode 0600.
     Postgres passwords must be URL-safe, because LiteLLM puts its password in a
     URL.
5. **Log in to the registry** with a read-only pull credential. Then render the
   LiteLLM config from the chart with the same values files a Helm deploy uses.
   This needs `helm`. If the VM has none, run it on a workstation and copy the
   file over.

   ```bash
   cd /opt/commonly/deploy/vm && mkdir -p litellm
   helm template commonly ../../k8s/helm/commonly \
     -f ../../k8s/helm/commonly/values-dev.yaml -f <private values file> \
     --show-only templates/configmaps/litellm-config.yaml \
     | docker run --rm -i mikefarah/yq:4.44.3 '.data["config.yaml"]' > litellm/config.yaml
   ```
6. **Start Postgres, load the data, then start the rest.** On an empty volume,
   `postgres` creates the admin, app and LiteLLM roles and the `litellm` schema.

   ```bash
   docker compose pull
   docker compose up -d --wait postgres
   # load the current Postgres data: see "Restore for real" below
   docker compose up -d --wait
   docker compose ps
   ```

   `pg-backup` reports healthy about a minute after it starts, and stays healthy
   until its first nightly run is due.

## Deploy a SHA

The VM pulls the backend, frontend and commonly-bot images by one tag, the
commit's short SHA. Build them first: dispatch the **Build VM Images** workflow
(`.github/workflows/build-vm-images.yml`) on `main`, with `ref` set to the full
SHA (empty means main HEAD). It holds the commit to the same gates as Deploy
Dev, a green `staging-smoke` and green post-merge Service Tests, and builds the
same three images with the same build args. It runs no helm and no kubectl.

Keep **Deploy Dev disabled while the VM serves.** Its helm upgrade scales the
cluster's backend, worker and bot back up, which puts a second scheduler and
Discord gateway on the same database. Deploy Staging is no substitute: it pushes
only a staging frontend (`<sha8>-staging`, with the staging API built in), so
the VM's frontend pull fails on a tag only staging built.

```bash
cd /opt/commonly && git fetch && git checkout <sha>
cd deploy/vm
# <tag> is exactly 8 characters: the one the build's notice names, or git rev-parse --short=8 <sha>.
sed -i 's/^COMMONLY_IMAGE_TAG=.*/COMMONLY_IMAGE_TAG=<tag>/' .env
# Re-render litellm/config.yaml (First setup, step 5) if the chart changed.
docker compose pull
docker compose up -d --wait
docker compose ps
curl -fsS https://api.commonly.me/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://commonly.me/
```

Then smoke the release: sign in, open a pod, send a message, and get one agent
reply. `up -d` recreates only the services whose image or config changed. After
cutover, the env files on the VM are the source of truth. Change a value there,
then run `docker compose up -d` again.

## One-off scripts

Run ops scripts in a fresh container from the same image and env, and always
give it a command. **`docker compose run backend` with no command runs the
image's start script.** That is a full second backend with its own scheduler
and Discord gateway, running beside the live one. Never `exec` into the serving
backend either: a heavy script there competes with live traffic (see
[ops-runner-and-no-exec-into-backend.md](../runbooks/ops-runner-and-no-exec-into-backend.md)).

```bash
docker compose run --rm --no-deps backend node dist/scripts/<name>.js
docker compose run --rm --no-deps -T backend node - < my-script.js
```

## Backups

`pg-backup` runs at `BACKUP_HOUR_UTC` (default 2) and stores two objects in
`BACKUP_S3_BUCKET`:

- `<prefix>/postgres/postgres-<stamp>.dump`
- `<prefix>/mongodb/mongodb-<stamp>.archive.gz`

Before uploading, it checks each dump. The Postgres dump must list table data,
and the Mongo archive must be at least `BACKUP_MONGO_MIN_BYTES`. Objects older
than `BACKUP_RETENTION_DAYS` (default 14) are pruned only after a night where
both dumps passed and uploaded. The Mongo URI reaches `mongodump` through a 0600
config file, not its command line. Give the R2 token object read and write on
that one bucket.

The Mongo archive is taken while the app keeps writing, without `--oplog`, so
it is not one point in time: a restore can mix collections from before and
after a related write. Adding `--oplog`, and restoring with `--oplogReplay`,
needs a replica set whose oplog the dump user can read, and a full dump of every
database: no `--db`, `--collection` or `--query`, and no database name in
`MONGO_URI`, which `mongodump` treats as `--db`. Check that your MongoDB host allows it
before turning it on. Where it doesn't, rely on the host's own snapshots for a
point-in-time copy, and treat this archive as a second copy.

- **Is it working?** `docker compose ps pg-backup` shows `unhealthy` once more
  than 26 hours pass without a successful run. `docker compose logs pg-backup`
  shows each run.
- **Run one now:** `docker compose run --rm --no-deps pg-backup once`. The
  success stamp lives in the `backup-state` volume, so a manual run clears the
  service's health too.
- **List what's stored:** `docker compose run --rm --no-deps -T pg-backup list`

### Restore test (monthly)

Restore into scratch copies, never into the live databases. Keep the dump in a
private temp file.

```bash
umask 077
dump=$(mktemp)
docker compose run --rm --no-deps -T pg-backup fetch postgres/<file>.dump > "$dump"
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" restore_test'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner --no-acl' < "$dump"
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d restore_test -tAc "select count(*) from messages"'
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" restore_test'
rm -f "$dump"

docker run -d --rm --name mongo-restore-test --network commonly_commonly mongo:<server major>
docker compose run --rm --no-deps -T pg-backup fetch mongodb/<file>.archive.gz \
  | docker run --rm -i --network commonly_commonly mongo:<server major> \
      mongorestore --uri mongodb://mongo-restore-test:27017 --archive --gzip
docker exec mongo-restore-test mongosh --quiet commonly --eval 'db.users.countDocuments()'
docker stop mongo-restore-test
```

Compare the counts with the live databases.

### Restore for real

The first load from the current Postgres works the same way, using a fresh
`pg_dump -Fc` of that server. If that server still holds LiteLLM's tables from
before they moved to their own schema, leave them and the views built on them
out of the dump; nothing in the backend reads them:

```bash
pg_dump -Fc --exclude-table 'public."LiteLLM_"*' --exclude-table 'public."DailyTagSpend"' \
  --exclude-table 'public."Last30d"*' --exclude-table 'public."MonthlyGlobalSpend"*' \
  --exclude-table 'public._prisma_migrations' "<current server URI>" > "$dump"
```

The quoted part of each pattern keeps its case and the trailing `*` stays a
wildcard.

1. Bring Postgres up on its own, and stop the writers:

   ```bash
   docker compose up -d --wait postgres
   docker compose stop backend litellm
   ```
2. Restore each schema as the role that owns it, so the restored objects stay
   owned by the app and by LiteLLM:

   ```bash
   umask 077
   dump=$(mktemp)
   docker compose run --rm --no-deps -T pg-backup fetch postgres/<file>.dump > "$dump"
   docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --clean --if-exists -n public --role "$PG_USER"' < "$dump"
   docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --clean --if-exists -n litellm --role "$LITELLM_PG_USER"' < "$dump"
   rm -f "$dump"
   ```
3. Start everything again with `docker compose up -d --wait`.

Restore MongoDB with `mongorestore --archive --gzip` against its URI only after
you have confirmed it is the database you mean to overwrite.

### Moving from the Kubernetes chart

MongoDB is shared during the move, so the cluster and the VM must never both
run. Two backends would fire every cron twice, log two Discord gateways in with
one token, and write chat to two Postgres servers. Do it in this order, in one
window:

1. **Before the window:**
   - Pull the images on the VM.
   - Give the VM its **own** tunnel, never the cluster's tunnel token. Two
     connectors on one tunnel split traffic between them.
   - Route the tunnel's hostnames to `http://frontend:80` and
     `http://backend:5000`, but don't point DNS at it yet.
2. **Stop anything that would scale the cluster back up,** such as a deploy
   workflow that upgrades the release.
3. **Scale every writer to zero:** the backend, the worker, LiteLLM,
   commonly-bot and any ops pod with database access. Suspend the CronJobs that
   write. Wait until their pods are gone. From here nothing writes Postgres or
   MongoDB.
4. **Render the env files and the accounts file now** (`render-env-from-k8s.sh`
   still reads the scaled-down Deployments). Copy them to the VM. Rendering
   after the freeze means no token issued in the gap is missed.
5. **Take the final `pg_dump`** of the current server and restore it as in
   "Restore for real" above.
6. **Start the stack** with `docker compose up -d --wait`.
7. **Point the hostnames' DNS records at the VM's tunnel.** Then stop the
   cluster's tunnel connector.
8. **Walk sign-in, a pod, chat, an agent reply and a summarizer run.**

To roll back:
1. Point DNS back.
2. Stop the VM's `backend`, `litellm` and `commonly-bot`.
3. **If the VM has taken writes:** dump the VM's Postgres now and restore it
   into the old server.
4. Scale the cluster back up and resume the CronJobs suspended in step 3.
5. Re-enable its deploy workflow.
6. **If agents were installed while the VM ran:** their tokens are only in the
   VM's accounts file. Run `reprovision-all` on the cluster so its bot gets
   them.

## Rollback

Set `COMMONLY_IMAGE_TAG` back to the previous SHA, check out that SHA, then run
`pull` and `up -d --wait` as in a deploy. Postgres data is not rolled back. If
the release added a Postgres migration, the old image refuses to start against
the new `schema_migrations` row. Follow "Rolling back across a Postgres
migration" in
[release-checklist-and-rollback.md](../runbooks/release-checklist-and-rollback.md),
and run its script with `docker compose run --rm --no-deps -T backend node -`.
