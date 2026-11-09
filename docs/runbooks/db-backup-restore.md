# Database backup and restore

Commonly can back up MongoDB and PostgreSQL to Google Cloud Storage with
Helm-managed CronJobs. The jobs are disabled by default. Enabling them before
the bucket, IAM role, and Workload Identity binding exist will only produce
failed Jobs, so complete the operator setup in order.

**commonly-dev has run them since 2026-10-14.** Both dump the external
databases the backend uses: MongoDB Atlas and Aiven PostgreSQL. The first
objects were a 142.5 MiB Mongo archive and a 9.4 MiB Postgres dump. Both were
restored in the isolated drill below, which reproduced every source count.
A failed run pages through the `commonly-dev: a Job or CronJob failed` alert
([alerting.md](alerting.md#job-failed)).

The jobs reuse the existing `database-credentials` Secret managed by External
Secrets Operator. They do not introduce another Kubernetes Secret.

## Backup layout and retention

Each database writes timestamped objects under its configured GCS path:

```text
gs://<bucket>/mongodb/daily/backup-YYYYMMDD-HHMMSS.archive.gz
gs://<bucket>/mongodb/weekly/backup-YYYYMMDD-HHMMSS.archive.gz
gs://<bucket>/postgresql/daily/backup-YYYYMMDD-HHMMSS.sql.gz
gs://<bucket>/postgresql/weekly/backup-YYYYMMDD-HHMMSS.sql.gz
```

Every successful run keeps the newest seven daily objects. A Sunday run also
copies that run's daily object into `weekly/` and keeps the newest four weekly
objects. Retention is enforced independently for MongoDB and PostgreSQL.

## One-time GCP setup

Choose the project, bucket, cluster namespace, and service account. The bucket
name must be globally unique.

```bash
export GCP_PROJECT="<gcp-project>"
export BACKUP_BUCKET="<globally-unique-backup-bucket>"
export GSA_NAME="commonly-backup"
export GSA_EMAIL="${GSA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
export K8S_NAMESPACE="commonly-dev"
```

Create a uniform-access bucket:

```bash
gcloud storage buckets create "gs://${BACKUP_BUCKET}" \
  --project="${GCP_PROJECT}" \
  --location=us-central1 \
  --uniform-bucket-level-access
```

Create the Google service account and grant bucket-scoped object management.
`roles/storage.objectAdmin` is required because the jobs upload, list, copy,
and delete objects during retention pruning.

```bash
gcloud iam service-accounts create "${GSA_NAME}" \
  --project="${GCP_PROJECT}" \
  --display-name="Commonly database backups"

gcloud storage buckets add-iam-policy-binding "gs://${BACKUP_BUCKET}" \
  --member="serviceAccount:${GSA_EMAIL}" \
  --role="roles/storage.objectAdmin"
```

Bind the Kubernetes `backup-sa` ServiceAccount to the Google service account
through GKE Workload Identity:

```bash
gcloud iam service-accounts add-iam-policy-binding "${GSA_EMAIL}" \
  --project="${GCP_PROJECT}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${GCP_PROJECT}.svc.id.goog[${K8S_NAMESPACE}/backup-sa]"
```

Confirm that Workload Identity is enabled on the target GKE cluster before
continuing. No service-account key file is needed or expected.

## Configure and enable in order

The bucket and service-account names identify the GCP project, so they must
not be committed. There are two ways to supply them.

**commonly-dev** enables both jobs in the committed `values-dev.yaml` and
writes the names as templates over the project id. That id already comes from
the private overlay as `externalSecrets.secretStore.projectId`. The chart
renders these fields through `tpl`:

```yaml
backup:
  gcpServiceAccount: "commonly-backup@{{ .Values.externalSecrets.secretStore.projectId }}.iam.gserviceaccount.com"
  mongodb:
    enabled: true
    gcs:
      bucket: "{{ .Values.externalSecrets.secretStore.projectId }}-db-backups"
```

**Any other install** can set literal values in its own private overlay
instead.

Before enabling, verify the render with your private overlay:

```bash
helm template commonly-dev k8s/helm/commonly \
  -f k8s/helm/commonly/values.yaml \
  -f k8s/helm/commonly/values-dev.yaml \
  -f .dev/values-private.yaml \
  --show-only templates/backup/backup-sa.yaml \
  --show-only templates/backup/mongodb-backup-cronjob.yaml \
  --show-only templates/backup/postgres-backup-cronjob.yaml
```

What the Postgres job dumps: it connects with the backend's own settings
(`backend.env.pgHost`, `pgPort`, `pgUser`, `pgDatabase`). When `pgSslEnabled`
is true it uses `PGSSLMODE=verify-full` against the `postgres-ca-cert`
Secret, the same CA the backend trusts. Its image is
`backup.postgresql.image`, **not** `postgresql.image`. `pg_dump` refuses a
server newer than itself. The in-cluster image is 15 and Aiven runs 16, so
bump `backup.postgresql.image.tag` when Aiven's major version moves. A
mismatch fails the job loudly; it does not write a bad dump.

Where the jobs run: **spot-pool**, because it is the only node pool whose
nodes run the GKE metadata server (`workloadMetadataConfig: GKE_METADATA`).
On dev-pool and default-pool, `gsutil` would see the node's own identity, not
`backup-sa`'s. Spot was avoided earlier for fear of preemption mid-dump. At
these sizes a dump takes about a minute, the Job retries once
(`backoffLimit: 1`), and a failure pages. Moving the jobs back to an
on-demand pool needs that pool switched to `GKE_METADATA` first.

Verify after a deploy:

```bash
kubectl get cronjob mongodb-backup postgres-backup -n "${K8S_NAMESPACE}"
kubectl get serviceaccount backup-sa -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}{"\n"}'
kubectl get cronjob mongodb-backup -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.nodeSelector}{"\n"}'
```

## Manual backup drill

Create one-off Jobs from the deployed CronJobs:

```bash
MONGO_JOB="mongodb-backup-$(date +%Y%m%d%H%M%S)"
kubectl create job --from=cronjob/mongodb-backup "${MONGO_JOB}" \
  -n "${K8S_NAMESPACE}"
kubectl wait --for=condition=complete --timeout=3600s \
  "job/${MONGO_JOB}" -n "${K8S_NAMESPACE}"
kubectl logs "job/${MONGO_JOB}" -n "${K8S_NAMESPACE}" -c mongodb-dump
kubectl logs "job/${MONGO_JOB}" -n "${K8S_NAMESPACE}" -c backup-uploader

POSTGRES_JOB="postgres-backup-$(date +%Y%m%d%H%M%S)"
kubectl create job --from=cronjob/postgres-backup "${POSTGRES_JOB}" \
  -n "${K8S_NAMESPACE}"
kubectl wait --for=condition=complete --timeout=3600s \
  "job/${POSTGRES_JOB}" -n "${K8S_NAMESPACE}"
kubectl logs "job/${POSTGRES_JOB}" -n "${K8S_NAMESPACE}" -c postgresql-dump
kubectl logs "job/${POSTGRES_JOB}" -n "${K8S_NAMESPACE}" -c backup-uploader
```

Confirm that both new daily objects are non-empty:

```bash
gsutil ls -l "gs://${BACKUP_BUCKET}/mongodb/daily/"
gsutil ls -l "gs://${BACKUP_BUCKET}/postgresql/daily/"
```

## Restore drill

Always restore into isolated databases first. The MongoDB command uses
`--drop`, and PostgreSQL plain SQL should be loaded into an empty target
database. Do not point either command at the live databases until the chosen
backup has passed the isolated restore and verification steps.

### External databases (Atlas, Aiven): restore inside a throwaway pod

commonly-dev's databases are external, so there is no in-cluster server to
restore into. Do not restore a copy into the production Atlas or Aiven
cluster: a second copy can push a small tier past its storage cap. The
2026-10-14 drill instead ran each restore in a pod that starts its own empty
server. The pod used `serviceAccountName: backup-sa` and the spot-pool
selector and toleration, so it could read the bucket. An init container ran
`gsutil cp` to fetch the object into an `emptyDir`. The main container then
ran:

```bash
# MongoDB, in a mongo:latest container
mongod --fork --logpath /tmp/mongod.log --dbpath /data/db --bind_ip 127.0.0.1
mongorestore --uri=mongodb://127.0.0.1:27017 --archive=/work/backup.archive.gz --gzip
mongosh --quiet mongodb://127.0.0.1:27017/commonly \
  --eval 'db.getCollectionNames().length; db.users.countDocuments()'

# PostgreSQL, in a postgres:16 container (POSTGRES_PASSWORD set)
docker-entrypoint.sh postgres &
until pg_isready -h 127.0.0.1 -U postgres -q; do sleep 1; done
psql -h 127.0.0.1 -U postgres -c 'CREATE ROLE avnadmin'   # the dump's object owner
createdb -h 127.0.0.1 -U postgres restore
gunzip -c /work/backup.sql.gz | psql -h 127.0.0.1 -U postgres -d restore -v ON_ERROR_STOP=1 -q
```

Compare the counts with the source, then delete the pod; its `emptyDir`
goes with it. The 2026-10-14 results:

| | Source | Restored |
|---|---|---|
| Mongo collections | 58 | 58 |
| users, pods, posts, installations, tasks | 820, 450, 715, 560, 1328 | identical |
| Postgres tables | 142 (134 tables + 8 views) | 142 |
| messages | 25,948 at count time | 25,946 at dump time; 2 were posted in between |

To recover production from a verified backup:

- **MongoDB:** run `mongorestore` against the Atlas cluster's URI, using the
  same `--nsInclude/--nsFrom/--nsTo` safety mapping as below.
- **PostgreSQL:** load the dump into an empty database on the Aiven service,
  then point `backend.env.pgDatabase` at it.

Aiven's and Atlas's own snapshots are separate, plan-dependent, and visible
only in their consoles.

### Restore drill in a throwaway namespace

The 2026-10-15 drill restored that night's scheduled objects in a namespace
created for the drill and deleted afterwards. Two things differ from the pod
above.

**Fetching the object.** Workload Identity binds the Google service account
to `${K8S_NAMESPACE}/backup-sa` only, so a pod in any other namespace cannot
read the bucket. A short-lived fetcher in the backup namespace streams the
object, and `kubectl exec -i` carries it into the restore pod. The bytes pass
through the operator's machine but are never written to its disk.

```bash
export DRILL_NS="restore-test-<mmdd>"
export MONGO_VERSION="<atlas-version>"   # mongosh: db.version()
export PG_VERSION="<aiven-version>"      # psql: SHOW server_version
export MONGO_OBJECT="gs://${BACKUP_BUCKET}/mongodb/daily/backup-<timestamp>.archive.gz"
export PG_OBJECT="gs://${BACKUP_BUCKET}/postgresql/daily/backup-<timestamp>.sql.gz"

kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata: {name: ${DRILL_NS}}
---
apiVersion: v1
kind: Pod
metadata: {name: mongo-restore, namespace: ${DRILL_NS}}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  nodeSelector: {workload-tier: spot}
  tolerations: [{key: workload-tier, operator: Equal, value: spot, effect: NoSchedule}]
  volumes: [{name: work, emptyDir: {}}, {name: data, emptyDir: {}}]
  containers:
  - name: mongo
    image: mongo:${MONGO_VERSION}
    command: [bash, -c, 'mongod --dbpath /data/db --bind_ip 127.0.0.1 --wiredTigerCacheSizeGB 0.5 --logpath /tmp/mongod.log & sleep 7200']
    resources: {requests: {cpu: 500m, memory: 2Gi}, limits: {cpu: "1", memory: 2Gi}}
    volumeMounts: [{name: work, mountPath: /work}, {name: data, mountPath: /data/db}]
---
apiVersion: v1
kind: Pod
metadata: {name: pg-restore, namespace: ${DRILL_NS}}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  nodeSelector: {workload-tier: spot}
  tolerations: [{key: workload-tier, operator: Equal, value: spot, effect: NoSchedule}]
  volumes: [{name: work, emptyDir: {}}, {name: data, emptyDir: {}}]
  containers:
  - name: postgres
    image: postgres:${PG_VERSION}
    env: [{name: POSTGRES_PASSWORD, value: drill-only}, {name: PGDATA, value: /var/lib/postgresql/data/pgdata}]
    resources: {requests: {cpu: 500m, memory: 1Gi}, limits: {cpu: "1", memory: 1Gi}}
    volumeMounts: [{name: work, mountPath: /work}, {name: data, mountPath: /var/lib/postgresql/data}]
---
apiVersion: v1
kind: Pod
metadata: {name: restore-fetch, namespace: ${K8S_NAMESPACE}}
spec:
  serviceAccountName: backup-sa
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  nodeSelector: {workload-tier: spot}
  tolerations: [{key: workload-tier, operator: Equal, value: spot, effect: NoSchedule}]
  containers:
  - name: fetch
    image: gcr.io/google.com/cloudsdktool/google-cloud-cli:slim
    command: [sleep, "3600"]
EOF
kubectl wait --for=condition=Ready --timeout=300s -n "${DRILL_NS}" pod/mongo-restore pod/pg-restore
kubectl wait --for=condition=Ready --timeout=300s -n "${K8S_NAMESPACE}" pod/restore-fetch

set -o pipefail
kubectl exec -n "${K8S_NAMESPACE}" restore-fetch -- gsutil -q cat "${MONGO_OBJECT}" \
  | kubectl exec -i -n "${DRILL_NS}" mongo-restore -- sh -c 'cat > /work/backup.archive.gz'
kubectl exec -n "${K8S_NAMESPACE}" restore-fetch -- gsutil -q cat "${PG_OBJECT}" \
  | kubectl exec -i -n "${DRILL_NS}" pg-restore -- sh -c 'cat > /work/backup.sql.gz'
kubectl delete pod restore-fetch -n "${K8S_NAMESPACE}"

# Integrity: GCS reports MD5 in base64, md5sum prints hex.
gcloud storage objects describe "${MONGO_OBJECT}" --format='value(size,md5_hash)'
kubectl exec -n "${DRILL_NS}" mongo-restore -- \
  sh -c 'stat -c %s /work/backup.archive.gz; md5sum /work/backup.archive.gz'
```

Then restore with the same commands as the pod above (`mongorestore
--uri=mongodb://127.0.0.1:27017 --archive=/work/backup.archive.gz --gzip`,
then `CREATE ROLE avnadmin`, `createdb`, and `gunzip -c | psql -v
ON_ERROR_STOP=1`), run through `kubectl exec -n "${DRILL_NS}"`.

**Comparing counts.** Production keeps moving after the dump, so a raw count
taken hours later never matches. Instead, count the production documents
created before the Job's `.status.startTime` and compare that number with the
restored count. Three effects can remain, and none of them is a lost row:

- `agentevents` is pruned by `agentEventService` after delivery, so its
  pre-cutoff count in production *falls* below the restored count.
- A row deleted after the dump lowers production's pre-cutoff count by one.
- The restored mongod runs its own TTL monitor, so a document past its
  `expiresAt` disappears seconds after `mongorestore` counts it as restored.
  `db.serverStatus().metrics.ttl.deletedDocuments` accounts for that gap.

The Postgres dump holds two schemas: `public` for the app, and `litellm` for
the LiteLLM proxy, which shares the Aiven database. Treat a restored copy as
holding credentials, because `LiteLLM_VerificationToken` stores the hashed
virtual keys.

Delete the namespace and confirm that nothing remains:

```bash
kubectl delete namespace "${DRILL_NS}" --wait=true
kubectl get namespace "${DRILL_NS}"                    # NotFound
kubectl get pod restore-fetch -n "${K8S_NAMESPACE}"    # NotFound
```

The 2026-10-15 results, from that night's 02:00Z CronJob objects:

| | Restored | Production, created before 02:00:00Z |
|---|---|---|
| Mongo collections | 58 | 58 |
| podassets | 146,871 | 146,871 |
| agentevents | 21,424 (90 written during the dump) | 20,178, pruned since |
| messages, agentruns, agentcredentials | 10,428, 7,229, 5,250 | identical |
| Postgres | 134 tables (65 `litellm`, 69 `public`) + 8 views | identical |
| `litellm` SpendLogGuardrailIndex, SpendLogToolIndex, VerificationToken, DailyUserSpend | 31,692, 8,556, 5,962, 5,601 | identical |
| `public.messages` | 26,189 | 26,188; one row deleted since |

Both objects matched their GCS size and MD5. Streaming the 147 MiB archive
took 12 s, `mongorestore` took 31 s (211,598 documents, 0 failed, 1 later
removed by TTL), and `psql` took 5 s. The namespace was gone less than six
minutes after it was created.

### In-cluster databases

#### MongoDB

Start a temporary client pod from the same MongoDB image configured in Helm,
copy the archive into it, and point the restore URI at an isolated database:

```bash
export MONGO_IMAGE="$(kubectl get cronjob mongodb-backup \
  -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.initContainers[?(@.name=="mongodb-dump")].image}')"
kubectl run mongodb-restore -n "${K8S_NAMESPACE}" \
  --image="${MONGO_IMAGE}" --restart=Never --command -- sleep 3600
kubectl wait --for=condition=Ready --timeout=120s \
  pod/mongodb-restore -n "${K8S_NAMESPACE}"
kubectl cp /tmp/mongodb-backup.archive.gz \
  "${K8S_NAMESPACE}/mongodb-restore:/tmp/backup.archive.gz"

MONGO_SOURCE_URI="$(kubectl get secret database-credentials \
  -n "${K8S_NAMESPACE}" -o jsonpath='{.data.mongo-uri}' | base64 --decode)"
MONGO_SOURCE_DB="${MONGO_SOURCE_URI%%\?*}"
MONGO_SOURCE_DB="${MONGO_SOURCE_DB##*/}"
unset MONGO_SOURCE_URI
if [[ ! "${MONGO_SOURCE_DB}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Could not derive a safe source database name from mongo-uri" >&2
  exit 1
fi
export MONGO_SOURCE_DB
export MONGO_RESTORE_DB="commonly_restore"
export MONGO_RESTORE_URI="<isolated-mongodb-uri-ending-in/commonly_restore>"
kubectl exec mongodb-restore -n "${K8S_NAMESPACE}" -- \
  env MONGO_URI="${MONGO_RESTORE_URI}" \
  MONGO_SOURCE_DB="${MONGO_SOURCE_DB}" \
  MONGO_RESTORE_DB="${MONGO_RESTORE_DB}" \
  bash -c '
    mongorestore \
      --uri="$MONGO_URI" \
      --archive=/tmp/backup.archive.gz \
      --gzip \
      --drop \
      --nsInclude="${MONGO_SOURCE_DB}.*" \
      --nsFrom="${MONGO_SOURCE_DB}.*" \
      --nsTo="${MONGO_RESTORE_DB}.*"
  '
```

**Load-bearing safety warning:** an archive records its original namespaces,
and `mongorestore --archive` ignores the database path in `--uri`. The
`--nsInclude` / `--nsFrom` / `--nsTo` mapping above is mandatory. Removing it
would make `--drop` target the live source database when the restore host is
the in-cluster MongoDB.

Inspect the restored collections, then delete the client pod:

```bash
kubectl exec mongodb-restore -n "${K8S_NAMESPACE}" -- \
  mongosh "${MONGO_RESTORE_URI}" --quiet \
  --eval 'db.getCollectionNames().sort()'
unset MONGO_RESTORE_URI MONGO_RESTORE_DB MONGO_SOURCE_DB MONGO_IMAGE
kubectl delete pod mongodb-restore -n "${K8S_NAMESPACE}"
```

#### PostgreSQL

Start a temporary PostgreSQL client pod, copy the SQL archive, and load it into
an empty isolated database:

```bash
export POSTGRES_IMAGE="$(kubectl get cronjob postgres-backup \
  -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.initContainers[?(@.name=="postgresql-dump")].image}')"
export PG_RESTORE_HOST="postgres.${K8S_NAMESPACE}.svc.cluster.local"
export PG_RESTORE_USER="$(kubectl get cronjob postgres-backup \
  -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.initContainers[?(@.name=="postgresql-dump")].env[?(@.name=="PG_USER")].value}')"
export PG_RESTORE_DATABASE="commonly_restore"

kubectl run postgresql-restore -n "${K8S_NAMESPACE}" \
  --image="${POSTGRES_IMAGE}" --restart=Never --command -- sleep 3600
kubectl wait --for=condition=Ready --timeout=120s \
  pod/postgresql-restore -n "${K8S_NAMESPACE}"
kubectl cp /tmp/postgresql-backup.sql.gz \
  "${K8S_NAMESPACE}/postgresql-restore:/tmp/backup.sql.gz"

PGPASSWORD="$(kubectl get secret database-credentials \
  -n "${K8S_NAMESPACE}" -o jsonpath='{.data.postgres-password}' | base64 --decode)"
kubectl exec postgresql-restore -n "${K8S_NAMESPACE}" -- \
  env PGPASSWORD="${PGPASSWORD}" \
  createdb -h "${PG_RESTORE_HOST}" -U "${PG_RESTORE_USER}" \
  "${PG_RESTORE_DATABASE}"
kubectl exec postgresql-restore -n "${K8S_NAMESPACE}" -- \
  env PGPASSWORD="${PGPASSWORD}" \
  PG_HOST="${PG_RESTORE_HOST}" \
  PG_USER="${PG_RESTORE_USER}" \
  PG_DATABASE="${PG_RESTORE_DATABASE}" \
  bash -c \
  'set -euo pipefail; gunzip -c /tmp/backup.sql.gz | psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -U "$PG_USER" -d "$PG_DATABASE"'
```

Inspect the restored schema and representative row counts, then remove the
client pod:

```bash
kubectl exec postgresql-restore -n "${K8S_NAMESPACE}" -- \
  env PGPASSWORD="${PGPASSWORD}" \
  psql -h "${PG_RESTORE_HOST}" -U "${PG_RESTORE_USER}" \
  -d "${PG_RESTORE_DATABASE}" -c '\\dt'
unset PGPASSWORD
kubectl delete pod postgresql-restore -n "${K8S_NAMESPACE}"
```

## Verification checklist

For every backup drill:

1. The Job reaches `Complete` before its one-hour deadline.
2. The dump initContainer and `backup-uploader` both exit with code 0.
3. The new GCS object has a non-zero size and the expected timestamped name.
4. Daily object count is at most seven; after a Sunday run, weekly count is at
   most four.
5. An isolated MongoDB restore exposes the expected collections and sample
   documents.
6. An isolated PostgreSQL restore exposes the expected tables and
   representative row counts.
7. Application smoke checks against restored databases can read users, pods,
   and recent messages before any production recovery is attempted.
