# Kubernetes Deployment Checklist

Quick reference for deploying Commonly to Kubernetes. See [KUBERNETES.md](./KUBERNETES.md) for detailed documentation.

## Pre-Deployment Checklist

- [ ] Kubernetes cluster running (1.24+)
- [ ] `kubectl` configured for your cluster
- [ ] `helm` installed (3.x)
- [ ] Docker registry access configured
- [ ] Domain/IP for ingress (or use nip.io for testing)

## Build Images

```bash
# Set your registry
export REGISTRY="gcr.io/your-project-id"
export DOMAIN="YOUR_IP.nip.io"  # or your actual domain

# Build backend
docker build -t ${REGISTRY}/commonly-backend:latest ./backend
docker push ${REGISTRY}/commonly-backend:latest

# Build frontend with API URL
docker build \
  -t ${REGISTRY}/commonly-frontend:latest \
  -f ./frontend/Dockerfile \
  --build-arg REACT_APP_API_URL=http://api.${DOMAIN} \
  ./frontend/
docker push ${REGISTRY}/commonly-frontend:latest
```

### Cloud Build (Backend + Frontend)

```bash
BACKEND_TAG=$(date +%Y%m%d%H%M%S)
FRONTEND_TAG=$(date +%Y%m%d%H%M%S)

gcloud builds submit backend --tag gcr.io/commonly-test/commonly-backend:${BACKEND_TAG}
gcloud builds submit frontend --tag gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG}
```

## Values Files

- `./k8s/helm/commonly/values.yaml` → default pool (production)
- `./k8s/helm/commonly/values-dev.yaml` → dev pool

## Create Secrets

### Database Credentials
```bash
kubectl create secret generic database-credentials \
  --namespace commonly \
  --from-literal=mongo-uri='mongodb://admin:YOUR_MONGO_PASSWORD@mongodb:27017/commonly?authSource=admin' \
  --from-literal=mongo-password='YOUR_MONGO_PASSWORD' \
  --from-literal=postgres-password='YOUR_PG_PASSWORD'
```

### API Keys (CRITICAL for CORS)
```bash
kubectl create secret generic api-keys \
  --namespace commonly \
  --from-literal=FRONTEND_URL="http://${DOMAIN}" \
  --from-literal=jwt-secret='YOUR_JWT_SECRET' \
  --from-literal=session-secret='YOUR_SESSION_SECRET' \
  --from-literal=SMTP2GO_API_KEY='YOUR_SMTP2GO_KEY' \
  --from-literal=SMTP2GO_FROM_EMAIL='support@yourdomain.com' \
  --from-literal=SMTP2GO_FROM_NAME='Your Team' \
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

## Deploy with Helm

```bash
helm install commonly ./k8s/helm/commonly \
  -f ./k8s/helm/commonly/values-dev.yaml \
  --namespace commonly \
  --create-namespace \
  --set externalSecrets.enabled=false \
  --set ingress.enabled=true \
  --set ingress.hosts.frontend.host=${DOMAIN} \
  --set ingress.hosts.backend.host=api.${DOMAIN}
```

Gateway strategy check:
- Ensure `agents.clawdbot.strategy.type=Recreate` in values files.
- This prevents `ReadWriteOnce` PVC multi-attach deadlocks during gateway upgrades.

## Verify Deployment

```bash
# Check all pods are running
kubectl get pods -n commonly

# Expected output:
# NAME                        READY   STATUS    RESTARTS   AGE
# backend-xxx-xxx             1/1     Running   0          2m
# backend-xxx-yyy             1/1     Running   0          2m
# frontend-xxx-xxx            1/1     Running   0          2m
# frontend-xxx-yyy            1/1     Running   0          2m
# mongodb-0                   1/1     Running   0          2m
# postgres-0                  1/1     Running   0          2m
# redis-xxx-xxx               1/1     Running   0          2m

# Check ingress
kubectl get ingress -n commonly

# Check backend is connected to databases
kubectl logs -n commonly -l app=backend | grep -E "MongoDB|PostgreSQL"
# Should see: "MongoDB connected" and "PostgreSQL connected"

# Verify FRONTEND_URL is set (CRITICAL for CORS)
kubectl exec -n commonly deployment/backend -- printenv FRONTEND_URL
# Should output: http://YOUR_DOMAIN

# Verify SMTP2GO is configured
kubectl exec -n commonly deployment/backend -- printenv | grep SMTP2GO
```

## Test Registration

```bash
# Test backend API directly
curl -X POST http://api.${DOMAIN}/api/auth/register \
  -H "Origin: http://${DOMAIN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"test123"}'

# Expected response:
# {"message":"User registered successfully. Check your email for verification."}
```

## Common Issues

### ❌ Registration fails with "Registration failed"

**Check:**
```bash
# 1. CORS - Is FRONTEND_URL set?
kubectl exec -n commonly deployment/backend -- printenv FRONTEND_URL

# 2. Is API URL correct in frontend?
kubectl exec -n commonly deployment/frontend -- \
  grep -o "api\.${DOMAIN}" /usr/share/nginx/html/static/js/main.*.js | head -1

# 3. Check backend logs for errors
kubectl logs -n commonly -l app=backend --tail=50
```

**Fix:**
- If FRONTEND_URL is empty, update the `api-keys` secret and restart backend
- If API URL is wrong in frontend, rebuild with correct `--build-arg REACT_APP_API_URL`

### ❌ Pods stuck in CreateContainerConfigError

**Check:**
```bash
kubectl describe pod -n commonly <pod-name> | grep "Error:"
```

**Fix:** Missing secret key - add it to the appropriate secret and delete the failed pod

### ❌ MongoDB authentication errors

**Check:**
```bash
kubectl logs -n commonly -l app=backend | grep "MongoDB"
```

**Fix:** Connection string must be: `mongodb://admin:PASSWORD@mongodb:27017/commonly?authSource=admin`

### ❌ CORS errors in browser console

**Check backend logs:**
```bash
kubectl logs -n commonly -l app=backend | grep CORS
```

**Fix:** Add your domain to FRONTEND_URL secret

## Post-Deployment

- [ ] Test user registration at `http://${DOMAIN}`
- [ ] Test user login
- [ ] Verify email verification works (check inbox)
- [ ] Create a pod
- [ ] Send a chat message
- [ ] Check message persistence after refresh

## Clean Database

Remove test users:
```bash
kubectl exec -n commonly deployment/backend -- node -e "
const mongoose = require('mongoose');
const User = require('./models/User');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const testEmails = ['test@example.com', 'test123@example.com'];
  const result = await User.deleteMany({ email: { \\\$in: testEmails } });
  console.log(\`Deleted \${result.deletedCount} test users\`);
  process.exit(0);
});
"
```

## Upgrade Deployment

```bash
# After code changes, rebuild and push images (Cloud Build)
BACKEND_TAG=$(date +%Y%m%d%H%M%S)
FRONTEND_TAG=$(date +%Y%m%d%H%M%S)
gcloud builds submit backend --tag gcr.io/commonly-test/commonly-backend:${BACKEND_TAG}
gcloud builds submit frontend --tag gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG}

# Roll out both components to both namespaces
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly
kubectl set image deployment/backend backend=gcr.io/commonly-test/commonly-backend:${BACKEND_TAG} -n commonly-dev
kubectl set image deployment/frontend frontend=gcr.io/commonly-test/commonly-frontend:${FRONTEND_TAG} -n commonly-dev

kubectl rollout status deployment/backend -n commonly
kubectl rollout status deployment/frontend -n commonly
kubectl rollout status deployment/backend -n commonly-dev
kubectl rollout status deployment/frontend -n commonly-dev
```

## Monitoring

```bash
# Watch pods
kubectl get pods -n commonly -w

# Stream backend logs
kubectl logs -n commonly -l app=backend -f

# Stream frontend logs
kubectl logs -n commonly -l app=frontend -f

# Check resource usage
kubectl top pods -n commonly
```

## Cleanup

```bash
# Remove everything
helm uninstall commonly --namespace commonly
kubectl delete namespace commonly
```

## Critical Configuration Summary

| Component | Requirement | Why |
|-----------|------------|-----|
| Frontend build | `--build-arg REACT_APP_API_URL=http://api.DOMAIN.com` | Frontend needs to know backend URL at build time |
| Backend FRONTEND_URL | Must match frontend domain | CORS will block requests without this |
| MongoDB URI | Must include `admin:PASSWORD@...?authSource=admin` | MongoDB requires authentication |
| SMTP2GO vars | Optional but recommended | Enables email verification (auto-verifies without) |
| axios import | `import axios from '../utils/axiosConfig'` | Ensures axios uses configured baseURL |

## Support

- Full guide: [KUBERNETES.md](./KUBERNETES.md)
- Architecture: [ARCHITECTURE.md](../ARCHITECTURE.md)
- General development: [CLAUDE.md](../../CLAUDE.md)
