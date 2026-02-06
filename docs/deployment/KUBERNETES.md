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

Backend build + rollout:

```bash
gcloud builds submit --config cloudbuild.backend.yaml .

# Production pool
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:latest -n commonly

# Dev pool
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:latest -n commonly-dev
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

## Important Configuration Notes

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
gcloud builds submit --config cloudbuild.backend.yaml .

# Upgrade with Helm
helm upgrade commonly ./k8s/helm/commonly \
  -f ./k8s/helm/commonly/values.yaml \
  --namespace default

helm upgrade commonly-dev ./k8s/helm/commonly \
  -f ./k8s/helm/commonly/values-dev.yaml \
  --namespace commonly-dev

# Or force rollout
kubectl rollout restart deployment backend -n default
kubectl rollout restart deployment frontend -n default
kubectl rollout restart deployment backend -n commonly-dev
kubectl rollout restart deployment frontend -n commonly-dev
```

## Production Considerations

### Security

1. **Use External Secrets** - Enable `externalSecrets.enabled=true` and configure External Secrets Operator
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
