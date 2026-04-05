# Helm Values Reference for Self-Hosters

This guide explains the key values you need to change when deploying Commonly on
your own infrastructure. The default `values.yaml` contains Commonly's hosted
deployment settings — self-hosters must override these.

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
(`gcr.io/disco-catcher-490606-b0/...`). You must build and push images to your
own registry, or use the public images when available.

```yaml
backend:
  image:
    repository: your-registry/commonly-backend
    tag: "latest"

frontend:
  image:
    repository: your-registry/commonly-frontend
    tag: "latest"

agents:
  clawdbot:
    image:
      repository: your-registry/clawdbot-gateway
      tag: "latest"
```

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
    tag: "latest"
  env:
    frontendUrl: "https://app.yourdomain.com"
    backendUrl: "https://api.yourdomain.com"
  nodeSelector: {}
  tolerations: []

frontend:
  image:
    repository: your-registry/commonly-frontend
    tag: "latest"
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
