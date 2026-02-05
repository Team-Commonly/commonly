---

name: devops
description: DevOps and infrastructure context for Docker, CI/CD, GitHub Actions, Kubernetes, Helm, deployment, and monitoring. Use when working on containers, pipelines, K8s, or deployment.
last_updated: 2026-02-05
---

# DevOps & Infrastructure

**Technologies**: Docker, Docker Compose, Kubernetes, Helm, GitHub Actions, Nginx, GKE, Prometheus

## Required Knowledge
- Docker containerization and multi-stage builds
- Docker Compose orchestration
- Kubernetes (K8s) cluster management and deployments
- Helm charts for package management
- CI/CD pipeline design (GitHub Actions)
- Nginx and Ingress configuration
- Secret management (K8s Secrets, External Secrets Operator)
- Environment variable management
- Monitoring and logging (Prometheus, Grafana, Stackdriver)

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [KUBERNETES.md](../../../docs/deployment/KUBERNETES.md) | K8s deployment, Helm, GKE, troubleshooting |
| [DEPLOYMENT.md](../../../docs/deployment/DEPLOYMENT.md) | Docker setup, CI/CD, scaling, monitoring |
| [ARCHITECTURE.md](../../../docs/architecture/ARCHITECTURE.md) | Container architecture |
| [LINTING.md](../../../docs/development/LINTING.md) | Code quality automation |

## Infrastructure Components

```
# Docker
docker-compose.yml          # Production configuration
docker-compose.dev.yml      # Development with hot reload

# Kubernetes
k8s/helm/commonly/
├── Chart.yaml              # Helm chart metadata
├── values.yaml             # Default values
├── values-dev.yaml         # Development overrides
└── templates/
    ├── core/
    │   ├── backend-deployment.yaml
    │   ├── frontend-deployment.yaml
    │   └── backend-service.yaml
    ├── databases/
    │   ├── mongodb-statefulset.yaml
    │   └── postgres-statefulset.yaml
    └── ingress.yaml        # NGINX Ingress rules

# CI/CD
.github/workflows/
├── tests.yml               # Automated testing
├── lint.yml                # Code quality checks
├── coverage.yml            # Test coverage reports
└── deploy.yml              # Production deployment
```

## Key Commands

### Docker Compose
```bash
# Development
./dev.sh up                 # Start dev environment
./dev.sh logs backend       # View backend logs
./dev.sh test               # Run tests

# Production
./prod.sh deploy            # Build and deploy
./prod.sh logs              # View logs
```

### Kubernetes
```bash
# Deploy with Helm
helm install commonly ./k8s/helm/commonly \
  -f ./k8s/helm/commonly/values-dev.yaml \
  --namespace commonly \
  --set externalSecrets.enabled=false

# Upgrade deployment
helm upgrade commonly ./k8s/helm/commonly \
  -f ./k8s/helm/commonly/values-dev.yaml \
  --namespace commonly

# Check status
kubectl get pods -n commonly
kubectl get svc -n commonly
kubectl get ingress -n commonly

# View logs
kubectl logs -n commonly -l app=backend --tail=50
kubectl logs -n commonly -l app=frontend --tail=50

# Restart deployment
kubectl rollout restart deployment backend -n commonly
kubectl rollout status deployment backend -n commonly

# Debug
kubectl describe pod -n commonly <pod-name>
kubectl exec -n commonly deployment/backend -- printenv

# Secrets
kubectl create secret generic api-keys \
  --namespace commonly \
  --from-literal=FRONTEND_URL='http://your-domain.com' \
  --from-literal=jwt-secret='your-secret'
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

## Kubernetes Deployment Notes (2026-02-05)

### Critical Configuration Requirements

1. **FRONTEND_URL Environment Variable**
   - Must be set in backend deployment for CORS to work
   - Add to `k8s/helm/commonly/templates/core/backend-deployment.yaml`:
   ```yaml
   - name: FRONTEND_URL
     valueFrom:
       secretKeyRef:
         name: api-keys
         key: FRONTEND_URL
   ```
   - Without this, registration/login will fail with CORS errors

2. **Frontend Build Arguments**
   - Frontend MUST be built with `REACT_APP_API_URL` build arg:
   ```bash
   docker build \
     --build-arg REACT_APP_API_URL=http://api.YOUR_DOMAIN.com \
     -t registry/commonly-frontend:latest \
     ./frontend/
   ```
   - The frontend imports axios from `./utils/axiosConfig` which uses this env var

3. **MongoDB Authentication**
   - Connection string must include credentials:
   ```
   mongodb://admin:PASSWORD@mongodb:27017/commonly?authSource=admin
   ```
   - Username must match `MONGO_INITDB_ROOT_USERNAME` in MongoDB deployment

4. **Email Verification**
   - Configure SMTP2GO environment variables in backend:
   ```yaml
   - name: SMTP2GO_API_KEY
   - name: SMTP2GO_FROM_EMAIL
   - name: SMTP2GO_FROM_NAME
   - name: SMTP2GO_BASE_URL
   ```
   - Without these, users are auto-verified in development mode

### Common Issues and Solutions

**Registration fails with CORS error:**
- Check `FRONTEND_URL` is set in backend: `kubectl exec -n commonly deployment/backend -- printenv FRONTEND_URL`
- Verify CORS allows your domain in backend logs

**Frontend can't reach backend:**
- Check API URL in frontend bundle: `kubectl exec -n commonly deployment/frontend -- grep -o 'api\.YOUR_DOMAIN' /usr/share/nginx/html/static/js/main.*.js`
- Rebuild frontend with correct `--build-arg REACT_APP_API_URL`

**Pods stuck in CreateContainerConfigError:**
- Check for missing secret keys: `kubectl describe pod -n commonly <pod-name> | grep "Error:"`
- Ensure all required keys exist in `api-keys` secret (see KUBERNETES.md)

### Files Modified for K8s

- `k8s/helm/commonly/templates/core/backend-deployment.yaml` - Added FRONTEND_URL and SMTP2GO env vars
- `frontend/src/components/Register.js` - Fixed axios import to use configured baseURL
- `frontend/src/components/Pod.js` - Fixed ESLint quote escaping

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
