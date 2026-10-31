# Helm Values Reference for Self-Hosters

This guide explains the key values you need to change when deploying Commonly on
your own infrastructure. The default `values.yaml` contains Commonly's hosted
deployment settings — self-hosters must override these.

The base chart's `values.yaml` ships `agents.clawdbot.enabled: true`. The
legacy gateway is optional, so self-hosters who do not deliberately run it
must override that value to `false`; the current hosted dev values do so.

## One-command local install

`./install.sh` uses `docker-compose.local.yml`, which runs MongoDB and a
pinned PostgreSQL 16 alongside the app, so chat, the tool broker, decisions
and reactions behave as they do under Helm.
See the [local installation guide](../deployment/SELF_HOSTED.md) for profile
selection. The Helm configuration below supports a PostgreSQL service or an
external PostgreSQL database.

## Quick Start

```bash
# Install with your own overrides
helm install commonly . \
  -f values.yaml \
  -f values-myorg.yaml   # your overrides file
```

Create `values-myorg.yaml` with the fields described below.

---

## Required Overrides

### Container Images

The default `values.yaml` references Commonly's private GCR registry
(`gcr.io/YOUR_GCP_PROJECT_ID/...`). You must build and push images to your
own registry, or use the public images when available. Set each application tag
to the exact build SHA you published. The chart carries the checked-in dev
snapshot tags as examples; they are not a promise that an image exists in your
registry. Reusing a mutable tag can silently change a deployment on the next pull.

```yaml
backend:
  image:
    repository: your-registry/commonly-backend
    tag: "YOUR_BUILD_SHA"

frontend:
  image:
    repository: your-registry/commonly-frontend
    tag: "YOUR_BUILD_SHA"

agents:
  clawdbot:
    enabled: false   # enable only when deliberately running the legacy gateway
    image:
      repository: your-registry/clawdbot-gateway
      tag: "YOUR_BUILD_SHA"
```

### Image pins (TASK-501, 2026-10-25)

The default Compose profile pins `mongo:9.0.4` and `postgres:17.11`.
The Helm MongoDB default also pins `mongo:9.0.4`. The MongoDB pin matches the
2026-10-25 `latest` digest. MongoDB 8.2 is end of life; its existing dev
reference is not used as the new default.

Compose deliberately uses PostgreSQL 17 to match its named-volume mount at
`/var/lib/postgresql/data`. The floating `latest` tag selected PostgreSQL 18.6,
which cannot start with that mount even on a fresh volume. Moving to PostgreSQL
18 requires a separate PR for the mount layout and `pg_upgrade`; this pin does
not migrate a volume previously written by PostgreSQL 18.

These are self-host image choices, not a measurement of the hosted databases:
`values-dev.yaml` disables the chart's MongoDB and PostgreSQL services.
Existing versioned references stay intact: local Compose and local/staging Helm
use MongoDB 7, dev Compose uses MongoDB 8.2, base/local Helm use PostgreSQL 15,
the backup client uses 16, and dev Compose uses 17. Redis remains `7-alpine`.
**PostgreSQL 15, 16 and 17 remain in use in the checked-in configuration**.
Unifying these versions and their volume layouts is a separate migration change.
For existing MongoDB volumes, upgrade stepwise through supported releases and
set the required FCV at each stage (for example, 7.0 → 8.0 before 9.0); never
point 9.0 at a 7.0 or 8.2 volume directly. Follow the
[MongoDB 9.0 upgrade prerequisites](https://www.mongodb.com/docs/manual/release-notes/9.0-upgrade-standalone/)
for the supported 8.0/8.3 source version and FCV requirements before changing
either the Compose or Helm MongoDB pin.

Pin evidence, checked 2026-10-25:

- [MongoDB latest tag](https://hub.docker.com/v2/repositories/library/mongo/tags/latest)
  and [9.0.4 tag](https://hub.docker.com/v2/repositories/library/mongo/tags/9.0.4):
  `sha256:dc28ed5a9d0fc616903c3f463bb1e53b92b49f441721b91926e87d90bf957ce8`.
- [PostgreSQL 17.11 tag](https://hub.docker.com/v2/repositories/library/postgres/tags/17.11):
  `sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe`.
- [MongoDB lifecycle policy](https://www.mongodb.com/legal/support-policy/lifecycles)
  lists 8.2 as end of life and 9.0 as supported.

Application image defaults use the four exact snapshot tags already recorded in
`values-dev.yaml`; deployments should override them with their own published
build SHAs. No image uses a `latest` tag in these Compose/Helm defaults. Version
tags may still receive rebuilt images; use digest overrides when your release
process requires byte-for-byte image immutability.

Before changing a pin on an existing installation, check the version that wrote
its persistent volume and follow the database's supported upgrade/downgrade
procedure. A tag edit does not migrate stored data.

### Ingress Hosts

```yaml
ingress:
  hosts:
    frontend:
      host: app.yourdomain.com
    backend:
      host: api.yourdomain.com
    litellm:
      host: litellm.yourdomain.com   # optional, only if running LiteLLM
```

### Database

**Option A: Use in-cluster MongoDB and PostgreSQL** (simplest for dev/demo)

```yaml
mongodb:
  enabled: true
  persistence:
    storageClass: standard   # change to your cluster's storage class
    size: 20Gi

postgresql:
  enabled: true
  persistence:
    storageClass: standard
    size: 20Gi
```

**Option B: Use external managed databases** (recommended for production)

```yaml
mongodb:
  enabled: false   # use MONGO_URI secret instead

postgresql:
  enabled: false   # use PG_* env vars instead

backend:
  env:
    pgHost: "your-postgres-host.example.com"
    pgPort: "5432"
    pgDatabase: "commonly"
    pgUser: "commonly_user"
    pgSslEnabled: "true"
```

### URLs

```yaml
backend:
  env:
    frontendUrl: "https://app.yourdomain.com"
    backendUrl: "https://api.yourdomain.com"
```

---

## Secrets

Commonly requires several secrets. The default setup uses GCP Secret Manager via
External Secrets Operator (ESO). For self-hosting, you can either:

**Option A: Disable ESO and use plain Kubernetes Secrets**

```yaml
externalSecrets:
  enabled: false
```

Then create secrets manually:

```bash
kubectl create secret generic api-keys \
  --from-literal=jwt-secret="$(openssl rand -hex 32)" \
  --from-literal=mongo-uri="mongodb://user:pass@host:27017/commonly?authSource=admin" \
  -n commonly

kubectl create secret generic database-credentials \
  --from-literal=postgres-password="your-pg-password" \
  -n commonly
```

**Option B: Use GCP Secret Manager (ESO)**

```yaml
externalSecrets:
  enabled: true
  secretStore:
    projectId: your-gcp-project-id        # change this
    clusterLocation: us-central1           # change to your region
    clusterName: your-cluster-name         # change this
```

Required secrets in GCP SM (or whichever secret store you configure):
| Secret name | Description |
|---|---|
| `jwt-secret` | JWT signing key (generate with `openssl rand -hex 32`) |
| `mongo-uri` | Full MongoDB connection string |
| `postgres-password` | PostgreSQL password |
| `anthropic-api-key` | For Claude-powered agents (optional) |
| `openai-api-key` | For OpenAI-powered agents (optional) |
| `openrouter-api-key` | For OpenRouter fallback (optional) |

---

## Node Selectors and Tolerations

The default `values-dev.yaml` uses GKE-specific node pool targeting
(`pool: dev`). Remove or replace these for your cluster:

```yaml
backend:
  nodeSelector: {}    # remove GKE-specific selectors
  tolerations: []     # remove GKE-specific tolerations

frontend:
  nodeSelector: {}
  tolerations: []
```

---

## TLS

TLS is disabled by default. Enable it after setting up cert-manager:

```yaml
ingress:
  tls:
    enabled: true
    # cert-manager will auto-provision certs if configured
```

---

## Minimal Self-Hosted values-myorg.yaml Example

```yaml
backend:
  image:
    repository: your-registry/commonly-backend
    tag: "YOUR_BUILD_SHA"
  env:
    frontendUrl: "https://app.yourdomain.com"
    backendUrl: "https://api.yourdomain.com"
  nodeSelector: {}
  tolerations: []

frontend:
  image:
    repository: your-registry/commonly-frontend
    tag: "YOUR_BUILD_SHA"
  nodeSelector: {}
  tolerations: []

mongodb:
  enabled: true
  persistence:
    storageClass: standard
    size: 20Gi

postgresql:
  enabled: true
  persistence:
    storageClass: standard
    size: 20Gi

redis:
  nodeSelector: {}
  tolerations: []

externalSecrets:
  enabled: false   # use kubectl create secret instead

ingress:
  hosts:
    frontend:
      host: app.yourdomain.com
    backend:
      host: api.yourdomain.com
  tls:
    enabled: false   # set true once cert-manager is ready

litellm:
  enabled: false   # enable only if you need LLM proxy routing
```
