# Kubernetes Migration - Quick Start Guide

This guide will help you deploy Commonly to Google Kubernetes Engine (GKE) in ~30 minutes.

## Prerequisites

- Google Cloud Project with billing enabled
- `gcloud` CLI installed and configured
- `kubectl` installed
- `helm` 3.12+ installed
- Docker for building images

## Step-by-Step Deployment

### 1. Configure GCP Project

```bash
# Set your project (replace with your actual project ID)
export PROJECT_ID="commonly-test"
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable container.googleapis.com secretmanager.googleapis.com

# Enable billing if not already done
gcloud beta billing projects link $PROJECT_ID --billing-account=YOUR_BILLING_ACCOUNT_ID
```

### 2. Create GKE Cluster (10 minutes)

```bash
# Create cluster (single-line command - easy to copy)
gcloud container clusters create commonly-dev --region us-central1 --num-nodes 3 --machine-type n2-standard-2 --disk-type pd-ssd --disk-size 100 --enable-autoscaling --min-nodes 3 --max-nodes 10 --enable-autorepair --enable-autoupgrade --workload-pool=${PROJECT_ID}.svc.id.goog --enable-shielded-nodes

# Connect kubectl
gcloud container clusters get-credentials commonly-dev --region us-central1
```

**Note**: Using `n2-standard-2` (2 vCPU, 8GB RAM) to stay within free tier quota. Upgrade to `n2-standard-4` if you have higher quota.

### 3. Install Prerequisites (5 minutes)

```bash
# External Secrets Operator
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets -n external-secrets-system --create-namespace

# NGINX Ingress Controller
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install nginx-ingress ingress-nginx/ingress-nginx --namespace ingress-nginx --create-namespace --set controller.service.type=LoadBalancer
```

### 4. Set Up GCP Secret Manager (10 minutes)

```bash
# Create GCP service account for secrets
gcloud iam service-accounts create commonly-secrets-sa --display-name="Commonly Secrets Manager"

# Grant Secret Manager access
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:commonly-secrets-sa@${PROJECT_ID}.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"

# Bind Kubernetes SA to GCP SA (Workload Identity)
gcloud iam service-accounts add-iam-policy-binding commonly-secrets-sa@${PROJECT_ID}.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser --member="serviceAccount:${PROJECT_ID}.svc.id.goog[commonly/external-secrets-sa]"
```

Now create secrets from your `.env` file values:

```bash
# Get values from your .env file (in /home/xcjsam/workspace/commonly/.env)

# Database credentials
echo -n "your_mongo_uri_from_env" | gcloud secrets create commonly-dev-mongo-uri --data-file=-
echo -n "your_postgres_password" | gcloud secrets create commonly-dev-postgres-password --data-file=-
echo -n "your_postgres_password" | gcloud secrets create commonly-dev-mongo-password --data-file=-

# JWT and Session
echo -n "your_jwt_secret_from_env" | gcloud secrets create commonly-dev-jwt-secret --data-file=-
echo -n "your_session_secret" | gcloud secrets create commonly-dev-session-secret --data-file=-

# AI API Keys
echo -n "your_gemini_api_key_from_env" | gcloud secrets create commonly-dev-gemini-api-key --data-file=-
echo -n "your_openai_key" | gcloud secrets create commonly-dev-openai-api-key --data-file=-
echo -n "your_anthropic_key" | gcloud secrets create commonly-dev-anthropic-api-key --data-file=-

# Discord
echo -n "your_discord_bot_token_from_env" | gcloud secrets create commonly-dev-discord-bot-token --data-file=-
echo -n "your_discord_client_id_from_env" | gcloud secrets create commonly-dev-discord-client-id --data-file=-
echo -n "your_discord_client_secret_from_env" | gcloud secrets create commonly-dev-discord-client-secret --data-file=-
echo -n "your_discord_guild_id" | gcloud secrets create commonly-dev-discord-guild-id --data-file=-

# OAuth (optional)
echo -n "your_google_client_id" | gcloud secrets create commonly-dev-google-client-id --data-file=-
echo -n "your_google_client_secret" | gcloud secrets create commonly-dev-google-client-secret --data-file=-
echo -n "your_github_client_id" | gcloud secrets create commonly-dev-github-client-id --data-file=-
echo -n "your_github_client_secret" | gcloud secrets create commonly-dev-github-client-secret --data-file=-

# Agent Runtime
echo -n "your_clawdbot_token" | gcloud secrets create commonly-dev-clawdbot-gateway-token --data-file=-
echo -n "your_commonly_bot_token" | gcloud secrets create commonly-dev-commonly-bot-runtime-token --data-file=-

# Other integrations (optional)
echo -n "your_slack_token" | gcloud secrets create commonly-dev-slack-bot-token --data-file=-
echo -n "your_groupme_id" | gcloud secrets create commonly-dev-groupme-bot-id --data-file=-
echo -n "your_telegram_token" | gcloud secrets create commonly-dev-telegram-bot-token --data-file=-
echo -n "your_litellm_key" | gcloud secrets create commonly-dev-litellm-master-key --data-file=-
```

### 5. Create Google Cloud Filestore (OPTIONAL - Skip for now)

**Filestore is only needed for agent workspaces. You can skip this step and deploy without agents first.**

If you want to enable agents later:

```bash
# Enable Filestore API (requires billing)
gcloud services enable filestore.googleapis.com

# Create Filestore instance (takes ~5 minutes, costs ~$200/month for 1TB)
gcloud filestore instances create commonly-agent-workspaces --zone=us-central1-a --tier=BASIC_HDD --file-share=name=agent_workspaces,capacity=1TB --network=name=default
```

**Alternative**: Use standard persistent disks (cheaper, works for most cases):
- Update `values-dev.yaml`: Set `agents.clawdbot.persistence.config.storageClass: standard-rwo`
- Set `agents.clawdbot.persistence.workspace.storageClass: standard-rwo`

### 6. Build and Push Docker Images (5 minutes)

```bash
cd /home/xcjsam/workspace/commonly

# Build backend
docker build -t gcr.io/${PROJECT_ID}/commonly-backend:v1.0.0 ./backend
docker push gcr.io/${PROJECT_ID}/commonly-backend:v1.0.0

# Build frontend
docker build -t gcr.io/${PROJECT_ID}/commonly-frontend:v1.0.0 ./frontend
docker push gcr.io/${PROJECT_ID}/commonly-frontend:v1.0.0
```

### 7. Update Helm Values

Edit `k8s/helm/commonly/values-dev.yaml`:

```yaml
# Replace PROJECT_ID with your GCP project ID
backend:
  image:
    repository: gcr.io/YOUR_PROJECT_ID/commonly-backend

frontend:
  image:
    repository: gcr.io/YOUR_PROJECT_ID/commonly-frontend

externalSecrets:
  secretStore:
    projectId: YOUR_PROJECT_ID
    clusterLocation: us-central1
    clusterName: commonly-dev
  serviceAccount:
    gcpServiceAccount: commonly-secrets-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 8. Deploy Commonly (2 minutes)

```bash
# Deploy with agents disabled (recommended for first deployment)
helm install commonly k8s/helm/commonly --namespace commonly --create-namespace --values k8s/helm/commonly/values-dev.yaml --set backend.image.tag=v1.0.0 --set frontend.image.tag=v1.0.0 --set agents.clawdbot.enabled=false
```

Or if you set up Filestore and want agents:

```bash
# Deploy with agents enabled
helm install commonly k8s/helm/commonly --namespace commonly --create-namespace --values k8s/helm/commonly/values-dev.yaml --set backend.image.tag=v1.0.0 --set frontend.image.tag=v1.0.0
```

### 9. Verify Deployment

```bash
# Check pods
kubectl get pods -n commonly

# Check services
kubectl get services -n commonly

# Check ingress
kubectl get ingress -n commonly

# View backend logs
kubectl logs -f deployment/backend -n commonly

# Check health
kubectl port-forward -n commonly deployment/backend 5000:5000
curl http://localhost:5000/api/health
```

### 10. Test Socket.io Multi-Pod

```bash
# Scale backend to 3 replicas
kubectl scale deployment/backend --replicas=3 -n commonly

# Verify all pods are running
kubectl get pods -n commonly -l app=backend

# Test real-time messaging through the frontend
```

---

## Quick Troubleshooting

### Pods not starting?

```bash
# Describe pod to see errors
kubectl describe pod <pod-name> -n commonly

# Check logs
kubectl logs <pod-name> -n commonly

# Check events
kubectl get events -n commonly --sort-by='.lastTimestamp'
```

### Secrets not loading?

```bash
# Check ExternalSecret status
kubectl get externalsecrets -n commonly
kubectl describe externalsecret database-credentials -n commonly

# Verify secrets were created
kubectl get secrets -n commonly
kubectl describe secret database-credentials -n commonly
```

### Database connection issues?

```bash
# Test MongoDB from backend pod
kubectl exec -it deployment/backend -n commonly -- mongosh $MONGO_URI

# Test PostgreSQL from backend pod
kubectl exec -it deployment/backend -n commonly -- psql -h postgres -U postgres -d commonly
```

### Redis not working?

```bash
# Check Redis pod
kubectl logs deployment/redis -n commonly

# Test Redis from backend pod
kubectl exec -it deployment/backend -n commonly -- redis-cli -h redis ping
```

---

## Accessing the Application

### Get Ingress IP

```bash
kubectl get ingress -n commonly
```

Update your DNS to point to the Ingress IP:
- `commonly-dev.example.com` → Frontend
- `api-dev.commonly.example.com` → Backend API

Or use `/etc/hosts` for testing:
```bash
echo "<INGRESS_IP> commonly-dev.example.com api-dev.commonly.example.com" | sudo tee -a /etc/hosts
```

---

## Testing Agent Provisioning

```bash
# Install an agent via API
curl -X POST http://api-dev.commonly.example.com/api/registry/agents/install \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "openclaw",
    "instanceId": "test-k8s-1",
    "podId": "YOUR_POD_ID"
  }'

# Verify Deployment was created
kubectl get deployments -n commonly | grep agent-moltbot

# Check agent logs
kubectl logs -f deployment/agent-moltbot-test-k8s-1 -n commonly

# Stop agent
curl -X POST http://api-dev.commonly.example.com/api/registry/agents/stop \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "test-k8s-1"}'

# Verify replicas scaled to 0
kubectl get deployment agent-moltbot-test-k8s-1 -n commonly
```

---

## Upgrading

```bash
# Build new images with new tag
docker build -t gcr.io/${PROJECT_ID}/commonly-backend:v1.1.0 ./backend
docker push gcr.io/${PROJECT_ID}/commonly-backend:v1.1.0

# Upgrade Helm release
helm upgrade commonly k8s/helm/commonly \
  --namespace commonly \
  --values k8s/helm/commonly/values-dev.yaml \
  --set backend.image.tag=v1.1.0
```

---

## Rollback

```bash
# List releases
helm history commonly -n commonly

# Rollback to previous version
helm rollback commonly -n commonly

# Rollback to specific revision
helm rollback commonly 2 -n commonly
```

---

## Cleanup

```bash
# Delete Helm release
helm uninstall commonly -n commonly

# Delete GKE cluster
gcloud container clusters delete commonly-dev --region us-central1

# Delete Filestore
gcloud filestore instances delete commonly-agent-workspaces --zone=us-central1-a

# Delete GCP secrets (optional)
gcloud secrets delete commonly-dev-mongo-uri
# ... delete all secrets
```

---

## Next Steps

1. Enable autoscaling (HPA) in `values-dev.yaml`
2. Enable backups in `values-dev.yaml`
3. Set up monitoring (Prometheus/Grafana)
4. Configure TLS certificates (cert-manager)
5. Set up CI/CD pipelines

See `k8s/MIGRATION_SUMMARY.md` for complete feature list and remaining tasks.
