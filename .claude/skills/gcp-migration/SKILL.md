---
name: gcp-migration
description: GCP project/account migration for the Commonly Kubernetes cluster. Use when migrating between GCP projects, accounts, or clusters — including full cluster teardown and rebuild.
last_updated: 2026-03-04

---

# GCP Cluster Migration

**Full guide**: `docs/deployment/GCP_MIGRATION.md`

## Current Cluster (post-migration 2026-03-04)

| Field | Value |
|-------|-------|
| Account | `YOUR_CODEX_ACCOUNT_2` |
| Project | `YOUR_OLD_GCP_PROJECT_ID` |
| Cluster | `commonly-dev` (us-central1) |
| kubectl context | `gke_YOUR_OLD_GCP_PROJECT_ID_us-central1_commonly-dev` |
| Registry | `gcr.io/YOUR_OLD_GCP_PROJECT_ID/` |
| GCS bucket | `gs://YOUR_OLD_GCP_PROJECT_ID_cloudbuild/` |

## Migration Phases

1. **Export** — secrets (decoded), cloudflared secret, configmaps, moltbot.json, agent workspaces
2. **New cluster** — enable APIs, create cluster + dev-pool, label nodes (`pool=dev`, `pool=default`)
3. **Build images** — backend, frontend, clawdbot (from `_external/clawdbot/`), commonly-bot; grant GKE SA `roles/storage.objectViewer`; update `values.yaml` registry refs
4. **Deploy** — nginx-ingress helm, label existing resources for helm adoption, `helm upgrade --install` for both namespaces
5. **Restore PVCs** — scale down clawdbot → busybox temp pod → copy moltbot.json + workspaces → scale back up
6. **Cutover** — delete old cluster, clean up local backup

## Critical Gotchas

### Clawdbot build must be submitted from its own directory
```bash
gcloud builds submit _external/clawdbot \
  --tag gcr.io/PROJECT/clawdbot-gateway:TAG \
  --machine-type=e2-highcpu-8 --async
```
Submitting from repo root fails with "no such file or directory".

### Helm won't adopt pre-existing resources
Label every pre-existing secret/configmap/namespace before `helm install`:
```bash
kubectl label secret api-keys -n commonly-dev app.kubernetes.io/managed-by=Helm --overwrite
kubectl annotate secret api-keys -n commonly-dev \
  meta.helm.sh/release-name=commonly-dev \
  meta.helm.sh/release-namespace=commonly-dev --overwrite
```

### agent-provisioner SA must pre-exist in `commonly` namespace
```bash
kubectl create serviceaccount agent-provisioner -n commonly
# then label + annotate for helm
```

### PVCs are ReadWriteOnce
Scale clawdbot to 0 before mounting its PVC in a temp pod. Otherwise attach fails.

### moltbot.json must have `dangerouslyAllowHostHeaderOriginFallback: true`
Gateway refuses to start without it. Verified in the existing backup — it's set in the exported moltbot.json.

### Cloudflare tunnel is not GCP-specific
Tunnel ID `YOUR_CLOUDFLARE_TUNNEL_ID` stays the same. Just restore the `cloudflared-commonly-k8s` secret to `ingress-nginx` namespace and the tunnel reconnects automatically.

## Build Commands (new project)

```bash
TAG=$(date +%Y%m%d%H%M%S)
PROJECT=YOUR_OLD_GCP_PROJECT_ID

# Backend
gcloud builds submit backend \
  --tag gcr.io/${PROJECT}/commonly-backend:${TAG} \
  --project $PROJECT --account YOUR_CODEX_ACCOUNT_2

# Frontend
gcloud builds submit frontend \
  --tag gcr.io/${PROJECT}/commonly-frontend:${TAG} \
  --project $PROJECT --account YOUR_CODEX_ACCOUNT_2

# Clawdbot (from its own dir)
gcloud builds submit _external/clawdbot \
  --tag gcr.io/${PROJECT}/clawdbot-gateway:${TAG} \
  --project $PROJECT --account YOUR_CODEX_ACCOUNT_2 \
  --machine-type=e2-highcpu-8

# commonly-bot
gcloud builds submit external/commonly-agent-services \
  --tag gcr.io/${PROJECT}/commonly-bot:${TAG} \
  --project $PROJECT --account YOUR_CODEX_ACCOUNT_2

# Tag as latest after build
gcloud container images add-tag \
  gcr.io/${PROJECT}/commonly-backend:${TAG} \
  gcr.io/${PROJECT}/commonly-backend:latest --quiet
```

## Secrets Reference (commonly-dev namespace)

Keys in `api-keys`: `jwt-secret`, `session-secret`, `gemini-api-key`, `brave-api-key`, `clawdbot-gateway-token`, `discord-bot-token`, `discord-client-id`, `discord-client-secret`, `google-client-id`, `google-client-secret`, `openrouter-api-key`, `slack-bot-token`, `telegram-bot-token`, `x-oauth-client-id`, `x-oauth-client-secret`, `SMTP2GO_*`, `FRONTEND_URL`, `GITHUB_TOKEN`

Keys in `database-credentials`: `mongo-uri`, `mongo-password`, `postgres-password`

Keys in `postgres-ca-cert`: `ca.pem`

## Verifying a Successful Migration

```bash
# All pods green in commonly-dev
kubectl get pods -n commonly-dev

# Cloudflare tunnel connected (look for "Registered tunnel connection")
kubectl logs -n ingress-nginx -l app=cloudflared-commonly-k8s --tail=10

# moltbot.json loaded with all accounts
CLAWDBOT_POD=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway \
  --no-headers -o custom-columns=NAME:.metadata.name | head -1)
kubectl exec -n commonly-dev $CLAWDBOT_POD -- cat /state/moltbot.json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); \
    print('accounts:', list(d['channels']['commonly']['accounts'].keys()))"
```
