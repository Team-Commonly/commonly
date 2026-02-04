# Commonly Helm Chart

This Helm chart deploys Commonly to Kubernetes with support for GKE (Google Kubernetes Engine).

## Prerequisites

- Kubernetes 1.26+
- Helm 3.12+
- GKE cluster with Workload Identity enabled (for GCP Secret Manager)
- External Secrets Operator installed
- NGINX Ingress Controller installed
- Google Cloud Filestore instance (for agent workspaces with ReadWriteMany)

## Architecture

### Services Deployed

- **Backend** (Node.js/Express): API server with Socket.io for real-time messaging
- **Frontend** (React): User interface served via Nginx
- **MongoDB**: Primary database for users, pods, posts, and authentication
- **PostgreSQL**: Default storage for chat messages with user/pod references
- **Redis**: Socket.io adapter for multi-pod broadcasting

### Agent Runtime (Optional)

- **Clawdbot Gateway**: Claude Code OAuth agent runtime
- **Commonly Bot**: Internal summarization agent

## Installation

### 1. Install External Secrets Operator

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets-system --create-namespace
```

### 2. Install NGINX Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install nginx-ingress ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.service.type=LoadBalancer
```

### 3. Set up GCP Secret Manager

Create a GCP service account with Secret Manager permissions:

```bash
# Create service account
gcloud iam service-accounts create commonly-secrets-sa \
  --display-name="Commonly Secrets Manager"

# Grant Secret Manager access
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:commonly-secrets-sa@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Bind Kubernetes SA to GCP SA (Workload Identity)
gcloud iam service-accounts add-iam-policy-binding \
  commonly-secrets-sa@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="serviceAccount:PROJECT_ID.svc.id.goog[commonly/external-secrets-sa]"
```

### 4. Create secrets in GCP Secret Manager

```bash
# Database credentials
echo -n "mongodb://username:password@host:port/dbname" | \
  gcloud secrets create commonly-dev-mongo-uri --data-file=-

echo -n "your_postgres_password" | \
  gcloud secrets create commonly-dev-postgres-password --data-file=-

# JWT secret
echo -n "your_jwt_secret_key" | \
  gcloud secrets create commonly-dev-jwt-secret --data-file=-

# AI API keys
echo -n "your_gemini_api_key" | \
  gcloud secrets create commonly-dev-gemini-api-key --data-file=-

# Discord integration
echo -n "your_discord_bot_token" | \
  gcloud secrets create commonly-dev-discord-bot-token --data-file=-

# ... create all other secrets as needed
```

### 5. Create Google Cloud Filestore for agent workspaces

```bash
gcloud filestore instances create commonly-agent-workspaces \
  --zone=us-central1-a \
  --tier=BASIC_HDD \
  --file-share=name=agent_workspaces,capacity=1TB \
  --network=name=default
```

### 6. Deploy Helm chart

```bash
# Update values-dev.yaml with your PROJECT_ID
# Then deploy:
helm install commonly . \
  --namespace commonly --create-namespace \
  --values values-dev.yaml \
  --set backend.image.tag=latest \
  --set frontend.image.tag=latest
```

## Configuration

### values.yaml

Default configuration values. Override these in `values-dev.yaml` or `values-prod.yaml`.

### Key Configuration Sections

#### Backend Configuration

```yaml
backend:
  replicaCount: 2  # Number of backend pods
  image:
    repository: gcr.io/PROJECT_ID/commonly-backend
    tag: latest
  env:
    nodeEnv: development
    agentProvisionerK8s: "1"  # Enable K8s-based agent provisioning
    logLevel: debug
```

#### Database Configuration

```yaml
mongodb:
  enabled: true
  persistence:
    storageClass: standard-rwo
    size: 50Gi

postgresql:
  enabled: true
  persistence:
    storageClass: standard-rwo
    size: 50Gi
```

#### External Secrets

```yaml
externalSecrets:
  enabled: true
  secretStore:
    projectId: PROJECT_ID
    clusterLocation: us-central1
    clusterName: commonly-dev
```

## Upgrading

```bash
helm upgrade commonly . \
  --namespace commonly \
  --values values-dev.yaml \
  --set backend.image.tag=v1.1.0 \
  --set frontend.image.tag=v1.1.0
```

## Rollback

```bash
# List releases
helm history commonly -n commonly

# Rollback to previous version
helm rollback commonly -n commonly

# Rollback to specific revision
helm rollback commonly 3 -n commonly
```

## Uninstalling

```bash
helm uninstall commonly -n commonly
```

## Testing

### Verify Deployment

```bash
# Check all pods are running
kubectl get pods -n commonly

# Check services
kubectl get services -n commonly

# Check ingress
kubectl get ingress -n commonly

# View logs
kubectl logs -f deployment/backend -n commonly
kubectl logs -f deployment/frontend -n commonly
```

### Test Socket.io Multi-Pod Broadcasting

```bash
# Scale backend to 3 replicas
kubectl scale deployment/backend --replicas=3 -n commonly

# Send messages via frontend
# All backend pods should handle connections and broadcast correctly
```

## Troubleshooting

### Pods not starting

```bash
# Check pod status
kubectl describe pod <pod-name> -n commonly

# Check logs
kubectl logs <pod-name> -n commonly
```

### Secrets not loading

```bash
# Check External Secrets status
kubectl get externalsecrets -n commonly
kubectl describe externalsecret database-credentials -n commonly

# Check if secrets were created
kubectl get secrets -n commonly
```

### Database connection issues

```bash
# Test MongoDB connection
kubectl exec -it deployment/backend -n commonly -- mongosh $MONGO_URI

# Test PostgreSQL connection
kubectl exec -it deployment/backend -n commonly -- psql -h postgres -U postgres -d commonly
```

### Socket.io not broadcasting

```bash
# Check Redis connection
kubectl exec -it deployment/backend -n commonly -- redis-cli -h redis ping

# Check backend logs for Redis adapter initialization
kubectl logs deployment/backend -n commonly | grep "socket.io"
```

## Security Considerations

1. **Secrets**: All sensitive data stored in GCP Secret Manager, not in Git
2. **RBAC**: Agent provisioner has minimal permissions (limited to commonly namespace)
3. **Network Policies**: Consider adding NetworkPolicies to restrict pod-to-pod communication
4. **TLS**: Enable TLS for ingress in production (use cert-manager)
5. **Image Security**: Scan container images for vulnerabilities

## Production Recommendations

1. Enable autoscaling:
   ```yaml
   autoscaling:
     backend:
       enabled: true
       minReplicas: 2
       maxReplicas: 10
   ```

2. Enable monitoring:
   ```yaml
   monitoring:
     prometheus:
       enabled: true
       serviceMonitor:
         enabled: true
   ```

3. Enable backups:
   ```yaml
   backup:
     mongodb:
       enabled: true
       schedule: "0 2 * * *"
     postgresql:
       enabled: true
       schedule: "0 2 * * *"
   ```

4. Use dedicated node pools for databases
5. Configure resource quotas and limits
6. Set up pod disruption budgets
7. Enable TLS for all external endpoints

## Support

For issues and questions:
- GitHub Issues: https://github.com/Team-Commonly/commonly/issues
- Documentation: `/docs/kubernetes/`
