# Database backup and restore

Commonly can back up MongoDB and PostgreSQL to Google Cloud Storage with
Helm-managed CronJobs. The jobs are disabled by default. Enabling them before
the bucket, IAM role, and Workload Identity binding exist will only produce
failed Jobs, so complete the operator setup in order.

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
export GSA_NAME="commonly-backup-sa"
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

Keep real bucket and service-account values in the operator-only
`.dev/values-private.yaml` file:

```yaml
backup:
  gcpServiceAccount: commonly-backup-sa@<gcp-project>.iam.gserviceaccount.com
  mongodb:
    gcs:
      bucket: <globally-unique-backup-bucket>
  postgresql:
    gcs:
      bucket: <globally-unique-backup-bucket>
```

Before enabling either job, verify the rendered resources with temporary
command-line overrides:

```bash
helm template commonly-dev k8s/helm/commonly \
  -f k8s/helm/commonly/values.yaml \
  -f k8s/helm/commonly/values-dev.yaml \
  -f .dev/values-private.yaml \
  --set backup.mongodb.enabled=true \
  --set backup.postgresql.enabled=true \
  --show-only templates/backup/backup-sa.yaml \
  --show-only templates/backup/mongodb-backup-cronjob.yaml \
  --show-only templates/backup/postgres-backup-cronjob.yaml
```

Only after the bucket, storage role, Workload Identity binding, and render are
verified, add the enablement flags to `.dev/values-private.yaml`:

```yaml
backup:
  mongodb:
    enabled: true
  postgresql:
    enabled: true
```

Deploy through the normal `Deploy Dev` workflow. Both committed values files
keep backup enablement `false`; the operator-private overlay is the only place
that flips the flags.

Verify the CronJobs and their on-demand scheduling constraints:

```bash
kubectl get cronjob mongodb-backup postgres-backup -n "${K8S_NAMESPACE}"
kubectl get serviceaccount backup-sa -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}{"\n"}'
kubectl get cronjob mongodb-backup -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.nodeSelector}{"\n"}'
kubectl get cronjob mongodb-backup -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.tolerations}{"\n"}'
```

The dev jobs must select `pool: dev` and tolerate only
`pool=dev:NoSchedule`. They must not tolerate the spot pool: ADR-015 permits
spot preemption with 30 seconds' notice, which can terminate a dump before a
usable artifact exists.

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

Download the selected objects:

```bash
gsutil cp \
  "gs://${BACKUP_BUCKET}/mongodb/daily/backup-<timestamp>.archive.gz" \
  /tmp/mongodb-backup.archive.gz
gsutil cp \
  "gs://${BACKUP_BUCKET}/postgresql/daily/backup-<timestamp>.sql.gz" \
  /tmp/postgresql-backup.sql.gz
```

### MongoDB

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

### PostgreSQL

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
