---
name: gcp-migration
description: GCP project/account migration for the Commonly Kubernetes cluster. Use when migrating between GCP projects, accounts, or clusters — including full cluster teardown and rebuild.
last_updated: 2026-03-22

---

# GCP Cluster Migration

**Full guide**: `docs/deployment/GCP_MIGRATION.md`

## Current Cluster (post-migration 2026-03-17)

| Field | Value |
|-------|-------|
| Account | `<your-gcp-account>` |
| Project | `<your-gcp-project>` (name: commonly) |
| Cluster | `commonly-dev` (us-central1) |
| kubectl context | `gke_<your-gcp-project>_us-central1_commonly-dev` |
| Registry | `gcr.io/<your-gcp-project>/` |
| GCS bucket | `gs://<your-gcp-project>_cloudbuild/` |

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
Gateway refuses to start without it. The provisioner sets this in ConfigMap + PVC on every provision. On a fresh cluster the PVC is empty — running `reprovision-all` (step below) re-seeds it via the init container.

### Frontend must be rebuilt with correct `REACT_APP_API_URL`
The frontend bakes the API URL at build time. After migration it will still point to the old/prod URL unless rebuilt. Use `frontend/cloudbuild.yaml` (in repo) which supports `--substitutions`:
```bash
FRONTEND_TAG=$(date +%Y%m%d%H%M%S)
gcloud builds submit frontend \
  --config frontend/cloudbuild.yaml \
  --project <your-gcp-project> --account <your-gcp-account> \
  --substitutions "_REACT_APP_API_URL=https://api-dev.commonly.me,_IMAGE=gcr.io/<your-gcp-project>/commonly-frontend:${FRONTEND_TAG}"
kubectl set image deployment/frontend frontend=gcr.io/<your-gcp-project>/commonly-frontend:${FRONTEND_TAG} -n commonly-dev
```
Note: `gcloud builds submit --tag` does NOT support `--build-arg`. Always use `--config` + `--substitutions`.

### After deploy: reprovision all agents
Fresh PVCs mean the gateway starts with no accounts → no agents connect via WebSocket. After all pods are up, run:
```bash
# Get admin JWT
TOKEN=$(kubectl exec -n commonly-dev deployment/backend -- node -e "
const mongoose=require('mongoose'),jwt=require('jsonwebtoken');
mongoose.connect(process.env.MONGO_URI).then(async()=>{
  const u=await mongoose.connection.db.collection('users').findOne({role:'admin'});
  console.log(jwt.sign({id:u._id},process.env.JWT_SECRET,{expiresIn:'1h'}));process.exit(0);
});")
kubectl exec -n commonly-dev deployment/backend -- curl -s -X POST \
  http://localhost:5000/api/registry/admin/installations/reprovision-all \
  -H "Authorization: Bearer $TOKEN"
# Should return {"success":true,"succeeded":N,"failed":0}
# Then verify: kubectl logs -n commonly-dev deployment/backend | grep "Agent connected"
```

### Cloudflare tunnel is not GCP-specific
Tunnel ID `YOUR_CLOUDFLARE_TUNNEL_ID` stays the same. Just restore the `cloudflared-commonly-k8s` secret to `ingress-nginx` namespace and the tunnel reconnects automatically.

## Build Commands (current project)

```bash
TAG=$(date +%Y%m%d%H%M%S)
PROJECT=<your-gcp-project>
ACCOUNT=<your-gcp-account>

# Backend
gcloud builds submit backend \
  --tag gcr.io/${PROJECT}/commonly-backend:${TAG} \
  --project $PROJECT --account $ACCOUNT

# Frontend — must use --config, not --tag (needs REACT_APP_API_URL build arg)
gcloud builds submit frontend \
  --config frontend/cloudbuild.yaml \
  --project $PROJECT --account $ACCOUNT \
  --substitutions "_REACT_APP_API_URL=https://api-dev.commonly.me,_IMAGE=gcr.io/${PROJECT}/commonly-frontend:${TAG}"
# For prod namespace: use _REACT_APP_API_URL=https://api.commonly.me

# Clawdbot — MUST use cloudbuild.gateway.yaml (--tag alone skips acpx install + gh CLI)
gcloud builds submit _external/clawdbot \
  --config _external/clawdbot/cloudbuild.gateway.yaml \
  --project $PROJECT --account $ACCOUNT \
  --substitutions "_IMAGE_TAG=${TAG}" \
  --machine-type=e2-highcpu-8

# commonly-bot
gcloud builds submit external/commonly-agent-services \
  --tag gcr.io/${PROJECT}/commonly-bot:${TAG} \
  --project $PROJECT --account $ACCOUNT

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
