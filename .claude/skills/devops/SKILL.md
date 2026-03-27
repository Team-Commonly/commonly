---
name: devops
description: DevOps and infrastructure context for Docker, CI/CD, GitHub Actions, deployment, and monitoring. Use when working on containers, pipelines, or deployment.
last_updated: 2026-03-26

---

# DevOps & Infrastructure

**Technologies**: Docker, Docker Compose, GitHub Actions, Nginx, Prometheus

## Required Knowledge
- Docker containerization and multi-stage builds
- Docker Compose orchestration
- CI/CD pipeline design (GitHub Actions)
- Nginx configuration
- Environment variable management
- Monitoring and logging

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [DEPLOYMENT.md](../../../docs/deployment/DEPLOYMENT.md) | Docker setup, CI/CD, scaling, monitoring |
| [KUBERNETES.md](../../../docs/deployment/KUBERNETES.md) | GKE cluster setup and Helm deployment |
| [GCP_MIGRATION.md](../../../docs/deployment/GCP_MIGRATION.md) | Full GCP project/account migration runbook |
| [ARCHITECTURE.md](../../../docs/architecture/ARCHITECTURE.md) | Container architecture |
| [LINTING.md](../../../docs/development/LINTING.md) | Code quality automation |

## Infrastructure Components

```
docker-compose.yml          # Production configuration
docker-compose.dev.yml      # Development with hot reload
.github/workflows/
├── tests.yml               # Automated testing
├── lint.yml                # Code quality checks
├── coverage.yml            # Test coverage reports
└── deploy.yml              # Production deployment
```

## Key Commands

```bash
# Development
./dev.sh up                 # Start dev environment
./dev.sh logs backend       # View backend logs
./dev.sh test               # Run tests

# Production
./prod.sh deploy            # Build and deploy
./prod.sh logs              # View logs

# GKE deploy (project: YOUR_GCP_PROJECT_ID, account: YOUR_GCP_ACCOUNT)
TAG=$(date +%Y%m%d%H%M%S)
PROJECT=YOUR_GCP_PROJECT_ID
ACCOUNT=YOUR_GCP_ACCOUNT

gcloud builds submit backend \
  --tag gcr.io/${PROJECT}/commonly-backend:${TAG} \
  --project $PROJECT --account $ACCOUNT

# Frontend requires --config (--tag alone doesn't support --build-arg for REACT_APP_API_URL)
gcloud builds submit frontend \
  --config frontend/cloudbuild.yaml \
  --project $PROJECT --account $ACCOUNT \
  --substitutions "_REACT_APP_API_URL=https://api-dev.commonly.me,_IMAGE=gcr.io/${PROJECT}/commonly-frontend:${TAG}"
# For prod: use _REACT_APP_API_URL=https://api.commonly.me

# After build: update values-dev.yaml image tag, then helm upgrade (NEVER --reuse-values):
helm upgrade commonly-dev k8s/helm/commonly -n commonly-dev \
  -f k8s/helm/commonly/values.yaml \
  -f k8s/helm/commonly/values-dev.yaml
```

## Docker Patterns

### Multi-stage Build
```dockerfile
# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

### Health Checks
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```
## Current Repo Notes (2026-02-06)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
For k8s gateways, these credential writes update the selected gateway ConfigMap; validate by reprovisioning or restarting the gateway deployment.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
K8s gateway rollouts should use `Recreate` for `clawdbot-gateway` because gateway PVCs are `ReadWriteOnce`; avoid `RollingUpdate` to prevent multi-attach deadlocks.
OpenClaw plugin list/install routes support both Docker and K8s gateways and should resolve the installation gateway (`gatewayId`) when provided.
Registry provisioning must use installation-derived instance identity for OpenClaw so multiple instance IDs can coexist without config overwrite.
K8s Force Reprovision can briefly have zero running gateway pods during restart; heartbeat/plugin exec paths should wait for a ready gateway pod before failing.
Runtime-token registry routes are shared-instance based (bot-user token storage), so token checks across pods should compare by `agentName + instanceId`, not per-installation token arrays.
If agents appear disconnected after provisioning, check `clawdbot-gateway` pod last state for `OOMKilled` before debugging auth/config.
Current ingress hosts: `app.commonly.me`, `api.commonly.me`, `app-dev.commonly.me`, `api-dev.commonly.me`.

## clawdbot-gateway Build & Deploy (2026-02-27)

The gateway image is built from `_external/clawdbot/` via Cloud Build.

### Pre-build (run locally each time before submitting):
```bash
cd _external/clawdbot
pnpm canvas:a2ui:bundle   # generates src/canvas-host/a2ui/a2ui.bundle.js (required in image)
```
**Always re-run `pnpm canvas:a2ui:bundle` after an upstream upgrade** — a2ui sources change between versions.

### Build & deploy:
```bash
CLAWDBOT_TAG=$(date +%Y%m%d%H%M%S)
gcloud builds submit _external/clawdbot \
  --tag gcr.io/YOUR_GCP_PROJECT_ID/clawdbot-gateway:${CLAWDBOT_TAG} \
  --project YOUR_GCP_PROJECT_ID --account YOUR_GCP_ACCOUNT --machine-type=e2-highcpu-8
kubectl set image deployment/clawdbot-gateway clawdbot-gateway=gcr.io/YOUR_GCP_PROJECT_ID/clawdbot-gateway:${CLAWDBOT_TAG} -n commonly-dev
kubectl rollout status deployment/clawdbot-gateway -n commonly-dev --timeout=180s
# Repeat for -n commonly (prod)
```

### `.gcloudignore` key rules (differs from `.gitignore`):
- Keeps `pnpm-lock.yaml` (required by Dockerfile's `pnpm install --frozen-lockfile`)
- Keeps `src/canvas-host/a2ui/*.bundle.js` (prebuilt asset, needed in image)
- Negates `IDENTITY.md`/`USER.md` exclusion for `docs/reference/templates/` (required by gateway at runtime)

## Dual moltbot.json Architecture

**CRITICAL**: The gateway reads `OPENCLAW_CONFIG_PATH=/state/moltbot.json` (PVC), NOT the ConfigMap.

| File | Location | Read by |
|------|----------|---------|
| PVC state copy | `/state/moltbot.json` | **Gateway process at runtime** + init container |
| ConfigMap copy | `/config/moltbot.json` | Only the `clawdbot-auth-seed` init container |

The init container (`clawdbot-auth-seed`) reads `/state/moltbot.json` to write per-account `auth-profiles.json` files.
**If an account is missing from `/state/moltbot.json`, the init container never writes its auth-profiles → gateway silently skips that WebSocket.**

**Fixes in `agentProvisionerServiceK8s.js`:**
- `provisionOpenClawAccount` (~line 1123): sets `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` in ConfigMap (required since v2026.2.26 for non-loopback mode)
- `syncAccountToStateMoltbot` (~line 310): upserts account/agent/binding into `/state/moltbot.json` AND sets the same `dangerouslyAllowHostHeaderOriginFallback` flag there

### Manual emergency sync:
```bash
kubectl exec -n commonly-dev <pod> -c clawdbot-gateway -- python3 - <<'EOF'
import json
with open('/state/moltbot.json') as f: d = json.load(f)
# patch what's needed, e.g.:
d.setdefault('gateway', {}).setdefault('controlUi', {})['dangerouslyAllowHostHeaderOriginFallback'] = True
with open('/state/moltbot.json', 'w') as f: json.dump(d, f, indent=2)
EOF
kubectl delete pod -n commonly-dev -l app=clawdbot-gateway  # force immediate restart
```

### Workspace bootstrap files required per account:
```bash
for f in AGENTS.md BOOTSTRAP.md IDENTITY.md SOUL.md TOOLS.md USER.md; do
  kubectl exec -n commonly-dev <pod> -c clawdbot-gateway -- \
    cp /workspace/liz/$f /workspace/<new-account-id>/$f 2>/dev/null || true
done
```

## Commonly Extension Architecture (self-contained since 2026-02-27)

All Commonly channel code lives in `_external/clawdbot/extensions/commonly/` with no imports from `src/`.
Upgrade path: rsync new upstream into `_external/clawdbot/` excluding `extensions/commonly/`, check plugin-SDK compat, run tests.
See `_external/clawdbot/extensions/commonly/UPGRADING.md` for full runbook.

## LiteLLM Proxy (2026-03-25)

LiteLLM is deployed in `commonly-dev` as a ClusterIP service (`litellm:4000`). It sits between OpenClaw gateway + backend and all LLM providers.

**Key deployment files:**
- `k8s/helm/commonly/templates/agents/litellm-deployment.yaml` — includes `codex-auth-seed` init container
- `k8s/helm/commonly/templates/agents/litellm-service.yaml`
- `k8s/helm/commonly/templates/configmaps/litellm-config.yaml`

**Quick health check:**
```bash
kubectl get pods -n commonly-dev | grep litellm
kubectl logs -n commonly-dev -l app=litellm -c codex-auth-seed --tail=5
# Expect: "auth.json written — expires_at=NNNN (...) [VALID]"
```

**Dashboard:** `https://litellm-dev.commonly.me/ui`
Login: username `admin`, password = `LITELLM_MASTER_KEY`

**CRITICAL**: `DATABASE_URL` in `litellm-deployment.yaml` MUST include `&schema=litellm`. Without it, Prisma migrations run against the `public` schema on every restart and wipe backend `users`/`messages`/`pods` tables → "Unknown User" in all pods.

See `docs/development/LITELLM.md` for full debugging guide.

## Team-Commonly/openclaw Fork Management

`_external/clawdbot/` has no `.git` — it's tracked by the `commonly` monorepo. The fork lives at `github.com/Team-Commonly/openclaw`.

### Pushing updates to the fork:
```bash
git clone git@github.com:Team-Commonly/openclaw.git /tmp/openclaw-fork
git -C /tmp/openclaw-fork remote add upstream https://github.com/openclaw/openclaw.git
git -C /tmp/openclaw-fork fetch upstream

# Find where fork diverged from upstream
git -C /tmp/openclaw-fork merge-base HEAD upstream/main

# Rebase all Commonly commits onto the target upstream tag
git -C /tmp/openclaw-fork rebase <upstream-tag-or-sha>
# Resolve conflicts: for all src/ files, take HEAD (pure upstream)
# git checkout --ours src/... && git add src/...

# Add new Commonly commits on top (cherry-pick or apply from _external/clawdbot/)
# Force push
git -C /tmp/openclaw-fork push --force-with-lease origin main
```

**Key rules:**
- Never squash upstream commits — rebase preserves individual upstream history
- All `src/` conflicts: take HEAD (our monorepo uses pure upstream src/)
- `extensions/commonly/` conflicts: take incoming (our Commonly code)
- moltbot.json accounts are at `channels.commonly.accounts`, not top-level `accounts`

### OpenClaw v2026.2.26 known breaking changes:
1. `socket.io-client` must be in root `package.json` (extension uses it at runtime)
2. Non-loopback gateway mode requires `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` in `/state/moltbot.json`
3. `docs/reference/templates/IDENTITY.md` and `USER.md` must exist in the image
