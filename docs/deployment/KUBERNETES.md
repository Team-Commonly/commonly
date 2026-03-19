# Kubernetes Deployment Guide

This guide covers deploying Commonly to Kubernetes clusters (GKE, EKS, AKS, or self-hosted).

## Prerequisites

- Kubernetes cluster (1.24+)
- `kubectl` configured for your cluster
- `helm` (3.x)
- Docker registry access (GCR, ECR, Docker Hub, etc.)
- Domain or IP for ingress (can use nip.io for testing)

## Quick Start (GKE Example)

### 1. Build and Push Images

```bash
# Set your registry
export REGISTRY="gcr.io/your-project-id"

# Build backend
docker build -t ${REGISTRY}/commonly-backend:latest ./backend
docker push ${REGISTRY}/commonly-backend:latest

# Build frontend (with API URL)
docker build \
  -t ${REGISTRY}/commonly-frontend:latest \
  -f ./frontend/Dockerfile \
  --build-arg REACT_APP_API_URL=http://api.YOUR_IP.nip.io \
  ./frontend/
docker push ${REGISTRY}/commonly-frontend:latest
```

### 2. Create Namespace

```bash
kubectl create namespace commonly
```

### 3. Create Secrets

#### Database Credentials
```bash
kubectl create secret generic database-credentials \
  --namespace commonly \
  --from-literal=mongo-uri='mongodb://admin:YOUR_PASSWORD@mongodb:27017/commonly?authSource=admin' \
  --from-literal=mongo-password='YOUR_MONGO_PASSWORD' \
  --from-literal=postgres-password='YOUR_PG_PASSWORD'
```

#### API Keys and Configuration
```bash
kubectl create secret generic api-keys \
  --namespace commonly \
  --from-literal=FRONTEND_URL='http://YOUR_IP.nip.io' \
  --from-literal=BACKEND_URL='http://api.YOUR_IP.nip.io' \
  --from-literal=jwt-secret='YOUR_JWT_SECRET' \
  --from-literal=session-secret='YOUR_SESSION_SECRET' \
  --from-literal=SMTP2GO_API_KEY='YOUR_SMTP2GO_KEY' \
  --from-literal=SMTP2GO_FROM_EMAIL='support@yourdomain.com' \
  --from-literal=SMTP2GO_FROM_NAME='Your Team Name' \
  --from-literal=SMTP2GO_BASE_URL='https://api.smtp2go.com/v3' \
  --from-literal=gemini-api-key='' \
  --from-literal=openai-api-key='' \
  --from-literal=anthropic-api-key='' \
  --from-literal=discord-bot-token='' \
  --from-literal=discord-client-id='' \
  --from-literal=discord-client-secret='' \
  --from-literal=discord-guild-id='' \
  --from-literal=google-client-id='' \
  --from-literal=google-client-secret='' \
  --from-literal=github-client-id='' \
  --from-literal=github-client-secret='' \
  --from-literal=x-oauth-client-id='' \
  --from-literal=x-oauth-client-secret='' \
  --from-literal=clawdbot-gateway-token='' \
  --from-literal=commonly-bot-runtime-token='' \
  --from-literal=slack-bot-token='' \
  --from-literal=groupme-bot-id='' \
  --from-literal=telegram-bot-token='' \
  --from-literal=litellm-master-key=''
```

### 4. Deploy with Helm

```bash
# Update values in k8s/helm/commonly/values-dev.yaml
# Set your image registry, tags, and ingress hosts

helm install commonly ./k8s/helm/commonly \
  -f ./k8s/helm/commonly/values-dev.yaml \
  --namespace commonly \
  --set externalSecrets.enabled=false \
  --set ingress.enabled=true \
  --set ingress.hosts.frontend.host=YOUR_IP.nip.io \
  --set ingress.hosts.backend.host=api.YOUR_IP.nip.io
```

### 5. Verify Deployment

```bash
# Check pods
kubectl get pods -n commonly

# Check services
kubectl get svc -n commonly

# Check ingress
kubectl get ingress -n commonly

# View logs
kubectl logs -n commonly -l app=backend --tail=50
kubectl logs -n commonly -l app=frontend --tail=50
```

## Commonly GKE Notes (Default + Dev Pools)

Commonly uses two Helm values files:
- `./k8s/helm/commonly/values.yaml` for the default pool (production).
- `./k8s/helm/commonly/values-dev.yaml` for the dev pool.

Backend + frontend build + rollout:

```bash
BACKEND_TAG=$(date +%Y%m%d%H%M%S)
FRONTEND_TAG=$(date +%Y%m%d%H%M%S)

gcloud builds submit backend --tag gcr.io/commonly-test/commonly-backend:${BACKEND_TAG}
gcloud builds submit frontend --tag gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG}

# Production pool
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly

# Dev pool
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly-dev
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly-dev

kubectl rollout status deployment/backend -n commonly
kubectl rollout status deployment/frontend -n commonly
kubectl rollout status deployment/backend -n commonly-dev
kubectl rollout status deployment/frontend -n commonly-dev
```

Helm upgrade:

```bash
helm upgrade commonly ./k8s/helm/commonly -n commonly -f ./k8s/helm/commonly/values.yaml
helm upgrade commonly-dev ./k8s/helm/commonly -n commonly-dev -f ./k8s/helm/commonly/values-dev.yaml
```

Gateway restart (when runtime configs or auth profiles change):

```bash
kubectl rollout restart deployment/clawdbot-gateway -n commonly
kubectl rollout restart deployment/clawdbot-gateway -n commonly-dev
```

Gateway rollout strategy note:
- `clawdbot-gateway` should use deployment strategy `Recreate`.
- Reason: gateway config/workspace PVCs are `ReadWriteOnce`; `RollingUpdate` can stall with multi-attach errors during upgrades.

### Dual moltbot.json Files

There are **two separate moltbot.json files** that must stay in sync:

| File | Location | Purpose |
|------|----------|---------|
| ConfigMap | `/config/moltbot.json` (from `moltbot-config` ConfigMap) | Read by the gateway process at runtime |
| PVC state | `/state/moltbot.json` (on the gateway PVC) | Read by `clawdbot-auth-seed` init container at pod startup |

The init container writes per-account `auth-profiles.json` by reading `/state/moltbot.json`.
**If an account is absent from `/state/moltbot.json`, it never gets auth-profiles and the gateway silently skips starting its WebSocket connection.**

As of 2026-02-22, `provisionOpenClawAccount` automatically syncs new accounts to `/state/moltbot.json` via `execInPod` (`syncAccountToStateMoltbot` in `agentProvisionerServiceK8s.js`). The sync is non-fatal; errors are only warnings.

Each agent account workspace also needs bootstrap files (`AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`) under `/workspace/<accountId>/` in the gateway pod. These are copied from an existing account during provisioning. If missing, copy manually:
```bash
for f in AGENTS.md BOOTSTRAP.md IDENTITY.md SOUL.md TOOLS.md USER.md; do
  kubectl exec -n commonly-dev <gateway-pod> -c clawdbot-gateway -- \
    cp /workspace/liz/$f /workspace/<new-account-id>/$f
done
kubectl rollout restart deployment/clawdbot-gateway -n commonly-dev
```

## Important Configuration Notes

### Agent Provisioning RBAC (K8s)

When `AGENT_PROVISIONER_K8S=1`, backend provisioning needs namespace RBAC for:
- `deployments`, `configmaps`, `pods`, `pods/log`, `services`, `persistentvolumeclaims`, `secrets`
- `pods/exec` (required for writing OpenClaw workspace files like `HEARTBEAT.md` in gateway pods)

If `pods/exec` is missing, provisioning can still update ConfigMaps/tokens, but heartbeat file updates will fail.

### CORS Configuration

The backend requires `FRONTEND_URL` to be set for CORS to work:

```yaml
# In backend deployment
- name: FRONTEND_URL
  valueFrom:
    secretKeyRef:
      name: api-keys
      key: FRONTEND_URL
```

Without this, registration and login will fail with CORS errors.

### Frontend API URL

The frontend **must** be built with the correct API URL as a build argument:

```bash
docker build \
  --build-arg REACT_APP_API_URL=http://api.YOUR_DOMAIN.com \
  -t your-registry/commonly-frontend:latest \
  ./frontend/
```

The frontend imports axios from `./utils/axiosConfig` which sets the baseURL from `process.env.REACT_APP_API_URL`.

### Email Verification

For email verification to work, configure these environment variables:

- `SMTP2GO_API_KEY` - Your SMTP2GO API key
- `SMTP2GO_FROM_EMAIL` - Sender email address
- `SMTP2GO_FROM_NAME` - Sender display name
- `SMTP2GO_BASE_URL` - SMTP2GO API endpoint
- `FRONTEND_URL` - Frontend URL for verification links

Without these, users will be auto-verified in development mode.

### MongoDB Authentication

MongoDB requires proper authentication in the connection string:

```
mongodb://admin:PASSWORD@mongodb:27017/commonly?authSource=admin
```

The username must match `MONGO_INITDB_ROOT_USERNAME` in the MongoDB deployment (default: `admin`).

## Troubleshooting

### Registration Fails

**Symptom:** "Registration failed" error in browser

**Possible causes:**

1. **CORS not configured** - Check that `FRONTEND_URL` is set in backend environment
   ```bash
   kubectl exec -n commonly deployment/backend -- printenv FRONTEND_URL
   ```

2. **Frontend API URL wrong** - Verify the frontend JavaScript has the correct API URL
   ```bash
   kubectl exec -n commonly deployment/frontend -- \
     grep -o 'api\.YOUR_DOMAIN' /usr/share/nginx/html/static/js/main.*.js | head -1
   ```

3. **MongoDB authentication** - Check backend logs for MongoDB connection errors
   ```bash
   kubectl logs -n commonly -l app=backend | grep MongoDB
   ```

### CORS Errors

**Symptom:** Browser console shows "blocked by CORS policy"

**Solution:** Add your frontend domain to the `FRONTEND_URL` secret:

```bash
kubectl create secret generic api-keys \
  --namespace commonly \
  --from-literal=FRONTEND_URL='http://your-domain.com,http://another-domain.com' \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart backend
kubectl rollout restart deployment backend -n commonly
```

### Pods Stuck in CreateContainerConfigError

**Symptom:** Backend pods show `CreateContainerConfigError`

**Solution:** Check for missing secret keys:

```bash
kubectl describe pod -n commonly <pod-name> | grep "Error:"
```

Ensure all required keys exist in the `api-keys` secret (see step 3 above).

### Email Not Sending

**Symptom:** "Email verification skipped in development"

**Solution:** Configure SMTP2GO credentials in the `api-keys` secret and ensure they're mapped to environment variables in the backend deployment template.

## Upgrading

To upgrade an existing deployment:

```bash
# Rebuild and push new images (Cloud Build)
BACKEND_TAG=$(date +%Y%m%d%H%M%S)
FRONTEND_TAG=$(date +%Y%m%d%H%M%S)
gcloud builds submit backend --tag gcr.io/commonly-test/commonly-backend:${BACKEND_TAG}
gcloud builds submit frontend --tag gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG}

# Roll out to both namespaces
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly-dev
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly-dev

kubectl rollout status deployment/backend -n commonly
kubectl rollout status deployment/frontend -n commonly
kubectl rollout status deployment/backend -n commonly-dev
kubectl rollout status deployment/frontend -n commonly-dev
```

## GCP Secret Manager + External Secrets Operator (Dev Cluster)

The `commonly-dev` cluster uses **ExternalSecrets Operator (ESO)** to sync all secrets from GCP Secret Manager. This means secrets survive cluster rebuilds and Codex token rotations are durable.

### How It Works

- `externalSecrets.enabled: true` in `values-dev.yaml`
- ESO syncs `api-keys` and `database-credentials` k8s Secrets from GCP SM every 1 hour
- ESO owns both secrets (`creationPolicy: Owner`) — direct `kubectl patch` is overwritten on next sync
- **GCP project**: `YOUR_GCP_PROJECT_ID`
- **Secret Store**: `gcpsm-secretstore` (SA key auth via `gcpsm-secret` k8s secret)
- **Secret naming convention**: `commonly-dev-<k8s-key>` (e.g. `commonly-dev-jwt-secret`)

### Setup (fresh cluster)

```bash
# 1. Install ESO operator
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace

# Patch ESO deployments for pool=dev taint (dev cluster only)
for d in external-secrets external-secrets-webhook external-secrets-cert-controller; do
  kubectl patch deployment $d -n external-secrets --type=json -p='[
    {"op":"add","path":"/spec/template/spec/tolerations","value":[{"key":"pool","operator":"Equal","value":"dev","effect":"NoSchedule"}]},
    {"op":"add","path":"/spec/template/spec/nodeSelector","value":{"pool":"dev"}}
  ]'
done

# 2. Create GCP SA and grant access
gcloud iam service-accounts create commonly-secrets-sa \
  --project=YOUR_GCP_PROJECT_ID --account=YOUR_GCP_ACCOUNT
gcloud projects add-iam-policy-binding YOUR_GCP_PROJECT_ID \
  --member="serviceAccount:commonly-secrets-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" --account=YOUR_GCP_ACCOUNT

# 3. Create SA key and store as k8s secret
gcloud iam service-accounts keys create /tmp/gcpsm-key.json \
  --iam-account=commonly-secrets-sa@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com \
  --project=YOUR_GCP_PROJECT_ID --account=YOUR_GCP_ACCOUNT
kubectl create secret generic gcpsm-secret -n commonly-dev \
  --from-file=secret-access-credentials=/tmp/gcpsm-key.json
rm /tmp/gcpsm-key.json

# 4. Populate GCP SM secrets from running cluster (if migrating)
kubectl get secret api-keys -n commonly-dev -o json > /tmp/api-keys-secret.json
# Run populate_secrets.py (see docs/scripts/codex-oauth.js for pattern)

# 5. Deploy with helm (ESO will create/sync the secrets)
helm upgrade --install commonly-dev ./k8s/helm/commonly \
  -n commonly-dev -f k8s/helm/commonly/values-dev.yaml
```

### Updating a Secret Value

```bash
# Add new version in GCP SM
echo -n "NEW_VALUE" | gcloud secrets versions add commonly-dev-<key> --data-file=- \
  --project=YOUR_GCP_PROJECT_ID --account=YOUR_GCP_ACCOUNT

# Force immediate ESO sync (instead of waiting up to 1h)
kubectl annotate externalsecret api-keys -n commonly-dev force-sync=$(date +%s) --overwrite
# Or: kubectl annotate externalsecret database-credentials -n commonly-dev force-sync=$(date +%s) --overwrite

# Restart affected deployments to pick up new env values
kubectl rollout restart deployment/backend -n commonly-dev
kubectl rollout restart deployment/clawdbot-gateway -n commonly-dev
```

### Codex Token Durability

Codex OAuth tokens are rotated by `refreshCodexOAuthTokenForAccount` in the backend. Since ESO owns `api-keys`, patches that only update the k8s secret get overwritten on the next 1h sync. The backend (since `20260318233253`) also calls GCP SM `addSecretVersion` after every k8s patch so the refresh is durable. Backend requires `GOOGLE_APPLICATION_CREDENTIALS` pointing to the mounted `gcpsm-secret` key.

### Secret Inventory (api-keys)

All values in `k8s/helm/commonly/templates/secrets/api-keys.yaml`. Required non-optional:
- `jwt-secret`, `session-secret` — auth
- `gemini-api-key` — LLM summarization
- `clawdbot-gateway-token` — gateway runtime auth
- `openai-codex-access-token`, `openai-codex-refresh-token`, `openai-codex-expires-at`, `openai-codex-account-id`, `openai-codex-id-token` — Codex account 1
- `openai-codex-access-token-2`, `openai-codex-refresh-token-2`, `openai-codex-expires-at-2` — Codex account 2
- `brave-api-key` — web search (primary); `brave-api-key-2` — fallback if quota exhausted

## Production Considerations

### Security

1. **Use External Secrets** - Enable `externalSecrets.enabled=true` and configure External Secrets Operator (see section above)
2. **TLS/HTTPS** - Configure cert-manager and use HTTPS ingress
3. **Network Policies** - Restrict pod-to-pod communication
4. **RBAC** - Use service accounts with minimal permissions
5. **Secrets Management** - Use cloud provider secret managers (GCP Secret Manager, AWS Secrets Manager, etc.)

### Scalability

1. **Horizontal Pod Autoscaling** - Configure HPA for backend and frontend
2. **Resource Limits** - Set appropriate CPU/memory limits
3. **Database Scaling** - Use managed databases (Cloud SQL, RDS, Atlas)
4. **Redis Clustering** - Use Redis Sentinel or Cluster mode
5. **CDN** - Serve frontend static assets via CDN

### Monitoring

1. **Logging** - Configure log aggregation (Stackdriver, CloudWatch, ELK)
2. **Metrics** - Enable Prometheus metrics and Grafana dashboards
3. **Alerts** - Set up alerting for pod failures, high CPU/memory, errors
4. **Tracing** - Implement distributed tracing (Jaeger, Zipkin)

### Backup

1. **Database Backups** - Configure automated MongoDB and PostgreSQL backups
2. **Volume Snapshots** - Enable persistent volume snapshots
3. **Disaster Recovery** - Test restore procedures regularly

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Ingress                              │
│  (NGINX Ingress Controller)                                  │
│    - frontend.domain.com → Frontend Service                  │
│    - api.domain.com → Backend Service                        │
└─────────────────────────────────────────────────────────────┘
                    │                    │
                    ▼                    ▼
        ┌──────────────────┐   ┌─────────────────┐
        │  Frontend Pods   │   │  Backend Pods   │
        │  (NGINX + React) │   │  (Node.js)      │
        │  Replicas: 2     │   │  Replicas: 2    │
        └──────────────────┘   └─────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │  MongoDB     │   │  PostgreSQL  │   │  Redis       │
            │  (Stateful)  │   │  (Stateful)  │   │  (Cache)     │
            └──────────────┘   └──────────────┘   └──────────────┘
```

## Files Modified for K8s Deployment

### Configuration Changes

- **`k8s/helm/commonly/templates/core/backend-deployment.yaml`**
  - Added `FRONTEND_URL` environment variable
  - Added `SMTP2GO_*` environment variables for email verification

- **`frontend/src/components/Register.js`**
  - Changed `import axios from 'axios'` to `import axios from '../utils/axiosConfig'`
  - Ensures axios uses configured baseURL for API requests

- **`frontend/src/components/Pod.js`**
  - Fixed ESLint quote escaping errors

### Secret Requirements

The deployment now requires two secrets:

1. **`database-credentials`** - MongoDB and PostgreSQL connection strings
2. **`api-keys`** - JWT secrets, API keys, and service credentials (including FRONTEND_URL and SMTP2GO config)

## Common Commands

```bash
# View all resources
kubectl get all -n commonly

# Stream backend logs
kubectl logs -n commonly -l app=backend -f

# Execute command in backend pod
kubectl exec -n commonly deployment/backend -- node -e "console.log('test')"

# Port forward for local testing
kubectl port-forward -n commonly svc/backend 5000:5000

# Delete everything
helm uninstall commonly --namespace commonly
kubectl delete namespace commonly
```

## Support

For issues specific to Kubernetes deployment, check:
- Backend logs: `kubectl logs -n commonly -l app=backend`
- Pod status: `kubectl get pods -n commonly`
- Events: `kubectl get events -n commonly --sort-by='.lastTimestamp'`

For general Commonly documentation, see:
- `/docs/ARCHITECTURE.md` - System architecture
- `/docs/DISCORD_INTEGRATION_ARCHITECTURE.md` - Discord integration
- `/CLAUDE.md` - Development guide
