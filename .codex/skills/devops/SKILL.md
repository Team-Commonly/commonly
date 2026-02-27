---
name: devops
description: DevOps and infrastructure context for Docker, CI/CD, GitHub Actions, deployment, and monitoring. Use when working on containers, pipelines, or deployment.
last_updated: 2026-02-22

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

# GKE (both namespaces)
BACKEND_TAG=$(date +%Y%m%d%H%M%S)
FRONTEND_TAG=$(date +%Y%m%d%H%M%S)
gcloud builds submit backend --tag gcr.io/commonly-test/commonly-backend:${BACKEND_TAG}
gcloud builds submit frontend --tag gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG}
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly-dev
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly-dev
kubectl rollout status deployment/backend -n commonly
kubectl rollout status deployment/frontend -n commonly
kubectl rollout status deployment/backend -n commonly-dev
kubectl rollout status deployment/frontend -n commonly-dev
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

## Dual moltbot.json Architecture (2026-02-22)

There are **two separate moltbot.json files** for the gateway in K8s:

| File | Location | Read by |
|------|----------|---------|
| ConfigMap copy | `/config/moltbot.json` (mounted from `moltbot-config` ConfigMap) | Gateway process at runtime |
| PVC state copy | `/state/moltbot.json` (on the gateway's PVC) | `clawdbot-auth-seed` init container at pod startup |

The init container (`clawdbot-auth-seed`) reads `/state/moltbot.json` to write per-account `auth-profiles.json` files before the gateway starts.
**If an account is missing from `/state/moltbot.json`, the init container never writes its auth-profiles, and the gateway silently skips starting a WebSocket connection for it.**

**Fix (deployed 2026-02-22):** `provisionOpenClawAccount` in `agentProvisionerServiceK8s.js` now calls `syncAccountToStateMoltbot` immediately after writing the ConfigMap. This runs a python3 heredoc via `execInPod` to upsert the account/agent/binding into `/state/moltbot.json` on the PVC. The sync is non-fatal (swallows errors if gateway pod isn't running yet).

### Manual sync (emergency):
```bash
# Exec into gateway pod and update /state/moltbot.json
kubectl exec -n commonly-dev <gateway-pod> -c clawdbot-gateway -- python3 - <<'EOF'
import json
with open('/state/moltbot.json') as f: d = json.load(f)
# Add missing account entry manually...
with open('/state/moltbot.json', 'w') as f: json.dump(d, f, indent=2)
EOF
# Then restart gateway to trigger init container re-run
kubectl rollout restart deployment/clawdbot-gateway -n commonly-dev
```

### Workspace bootstrap files required per account:
The gateway also requires workspace bootstrap files to start an account session.
If missing, copy from a working account:
```bash
for f in AGENTS.md BOOTSTRAP.md IDENTITY.md SOUL.md TOOLS.md USER.md; do
  kubectl exec -n commonly-dev <gateway-pod> -c clawdbot-gateway -- \
    cp /workspace/liz/$f /workspace/<new-account-id>/$f 2>/dev/null || true
done
```
