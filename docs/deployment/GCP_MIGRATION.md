# GCP Project Migration Guide

This document covers how to migrate the Commonly Kubernetes cluster from one GCP project/account to another. Performed 2026-03-04: `commonly-test` (xcjsam@g.ucla.edu) → `gen-lang-client-0826504762` (xcjsam@gmail.com).

## Overview

The migration involves six phases:
1. Export secrets and PVC data from the old cluster
2. Create a new cluster on the new project
3. Rebuild container images in the new project's registry
4. Apply secrets, configmaps, and deploy via Helm
5. Restore PVC data (moltbot.json, agent workspaces)
6. Delete the old cluster

## Current Cluster Info

| Field | Value |
|-------|-------|
| GCP Account | `xcjsam@gmail.com` |
| Project ID | `gen-lang-client-0826504762` |
| Project Name | Commonly |
| Cluster | `commonly-dev` |
| Region | `us-central1` |
| Node pools | `default-pool` (2× n2-standard-2), `dev-pool` (1× n2-standard-2) |
| kubectl context | `gke_gen-lang-client-0826504762_us-central1_commonly-dev` |
| Namespaces | `commonly` (prod), `commonly-dev` (dev) |
| Image registry | `gcr.io/gen-lang-client-0826504762/` |
| Skills catalog GCS | `gs://gen-lang-client-0826504762_cloudbuild/awesome-agent-skills-index.json` |

---

## Phase 1 — Export from Old Cluster

### 1.1 Authenticate both accounts

```bash
gcloud auth login NEW_ACCOUNT@gmail.com
# verify old account is still available
gcloud auth list
```

### 1.2 Export secrets (decoded)

```bash
mkdir -p /tmp/k8s-migration/{secrets,pvcs}

for ns in commonly commonly-dev; do
  for secret in api-keys database-credentials postgres-ca-cert; do
    kubectl get secret $secret -n $ns -o json | python3 -c "
import json,sys,base64
d=json.load(sys.stdin)
print(f'=== $ns/$secret ===')
for k,v in d.get('data',{}).items():
    print(f'{k}: {base64.b64decode(v).decode(\"utf-8\",errors=\"replace\")}')
" >> /tmp/k8s-migration/secrets/all-decoded.txt
  done
done
```

### 1.3 Export cloudflared secret

```bash
kubectl get secret cloudflared-commonly-k8s -n ingress-nginx -o yaml \
  | grep -v "creationTimestamp\|resourceVersion\|uid\|managedFields" \
  > /tmp/k8s-migration/secrets/ingress-nginx-cloudflared-commonly-k8s.yaml
```

### 1.4 Export configmaps

```bash
for ns in commonly commonly-dev; do
  for cm in clawdbot-config commonly-bot-config marketplace-manifest skills-catalog; do
    kubectl get configmap $cm -n $ns -o yaml \
      | grep -v "creationTimestamp\|resourceVersion\|uid\|managedFields" \
      > /tmp/k8s-migration/secrets/${ns}-cm-${cm}.yaml
  done
done
```

### 1.5 Export clawdbot PVC data

The clawdbot pod must be running to copy from it.

```bash
CLAWDBOT_POD=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway \
  --no-headers -o custom-columns=NAME:.metadata.name | head -1)

# moltbot.json (critical — contains all agent account configs)
kubectl exec -n commonly-dev $CLAWDBOT_POD -- cat /state/moltbot.json \
  > /tmp/k8s-migration/pvcs/commonly-dev-moltbot.json

# agent workspaces and skills
kubectl cp commonly-dev/${CLAWDBOT_POD}:/workspace /tmp/k8s-migration/pvcs/workspace
```

---

## Phase 2 — Create New Cluster

### 2.1 Enable APIs on new project

```bash
gcloud services enable container.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  compute.googleapis.com \
  --project NEW_PROJECT --account NEW_ACCOUNT
```

### 2.2 Create cluster

```bash
gcloud container clusters create commonly-dev \
  --project NEW_PROJECT \
  --account NEW_ACCOUNT \
  --region us-central1 \
  --release-channel regular \
  --num-nodes 1 \
  --machine-type n2-standard-2 \
  --node-locations us-central1-a \
  --no-enable-basic-auth
```

### 2.3 Add dev node pool

```bash
gcloud container node-pools create dev-pool \
  --cluster commonly-dev \
  --region us-central1 \
  --project NEW_PROJECT \
  --account NEW_ACCOUNT \
  --machine-type n2-standard-2 \
  --num-nodes 1 \
  --node-locations us-central1-a \
  --async
```

### 2.4 Label nodes

The helm chart uses `pool=dev` / `pool=default` nodeSelectors:

```bash
DEV_NODE=$(kubectl get nodes -l cloud.google.com/gke-nodepool=dev-pool \
  --no-headers -o custom-columns=NAME:.metadata.name | head -1)
DEFAULT_NODE=$(kubectl get nodes -l cloud.google.com/gke-nodepool=default-pool \
  --no-headers --o custom-columns=NAME:.metadata.name | head -1)

kubectl label node $DEV_NODE pool=dev --overwrite
kubectl label node $DEFAULT_NODE pool=default --overwrite
```

---

## Phase 3 — Build Images

### 3.1 Upload skills catalog to new GCS bucket

```bash
NEW_PROJECT=gen-lang-client-0826504762

gcloud storage buckets create gs://${NEW_PROJECT}_cloudbuild \
  --project $NEW_PROJECT --account NEW_ACCOUNT --location us-central1

gcloud storage cp k8s/helm/commonly/configs/awesome-agent-skills-index.json \
  gs://${NEW_PROJECT}_cloudbuild/awesome-agent-skills-index.json \
  --project $NEW_PROJECT --account NEW_ACCOUNT

gcloud storage buckets add-iam-policy-binding gs://${NEW_PROJECT}_cloudbuild \
  --member=allUsers --role=roles/storage.objectViewer \
  --project $NEW_PROJECT --account NEW_ACCOUNT
```

### 3.2 Build and push images

```bash
TAG=$(date +%Y%m%d%H%M%S)
NEW_PROJECT=gen-lang-client-0826504762

# Backend
gcloud builds submit . \
  --tag gcr.io/${NEW_PROJECT}/commonly-backend:${TAG} \
  --project $NEW_PROJECT --account NEW_ACCOUNT --async

# Frontend
gcloud builds submit . \
  --config cloudbuild.frontend.yaml \
  --project $NEW_PROJECT --account NEW_ACCOUNT --async

# Clawdbot — MUST be submitted from _external/clawdbot directory
gcloud builds submit _external/clawdbot \
  --tag gcr.io/${NEW_PROJECT}/clawdbot-gateway:${TAG} \
  --project $NEW_PROJECT --account NEW_ACCOUNT \
  --machine-type=e2-highcpu-8 --async

# commonly-bot
gcloud builds submit external/commonly-agent-services \
  --tag gcr.io/${NEW_PROJECT}/commonly-bot:${TAG} \
  --project $NEW_PROJECT --account NEW_ACCOUNT --async
```

### 3.3 Grant GKE access to GCR

```bash
PROJECT_NUMBER=$(gcloud projects describe $NEW_PROJECT --format="value(projectNumber)")
gcloud projects add-iam-policy-binding $NEW_PROJECT \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectViewer" \
  --account NEW_ACCOUNT
```

### 3.4 Update values files

Replace all `gcr.io/OLD_PROJECT/` and `OLD_PROJECT_cloudbuild` references:

```bash
sed -i \
  's|gcr.io/OLD_PROJECT/|gcr.io/NEW_PROJECT/|g
   s|OLD_PROJECT_cloudbuild|NEW_PROJECT_cloudbuild|g' \
  k8s/helm/commonly/values.yaml \
  k8s/helm/commonly/values-dev.yaml
```

---

## Phase 4 — Deploy

### 4.1 Get credentials and create namespaces

```bash
gcloud container clusters get-credentials commonly-dev \
  --region us-central1 --project NEW_PROJECT --account NEW_ACCOUNT

kubectl create namespace commonly
kubectl create namespace commonly-dev
kubectl create namespace ingress-nginx
```

### 4.2 Apply secrets

Recreate each secret using `--from-literal` (avoids annotation encoding issues with `kubectl apply -f`):

```bash
# Example for commonly-dev/api-keys — repeat for each namespace/secret
kubectl create secret generic api-keys -n commonly-dev \
  --from-literal=jwt-secret='...' \
  --from-literal=gemini-api-key='...' \
  # ... all keys
  --dry-run=client -o yaml | kubectl apply -f -
```

See decoded values from Phase 1.3 export.

### 4.3 Apply configmaps and cloudflared secret

```bash
kubectl apply -f /tmp/k8s-migration/secrets/ingress-nginx-cloudflared-commonly-k8s.yaml \
  -n ingress-nginx

for ns in commonly commonly-dev; do
  for cm in clawdbot-config commonly-bot-config marketplace-manifest skills-catalog; do
    kubectl apply -f /tmp/k8s-migration/secrets/${ns}-cm-${cm}.yaml -n $ns
  done
done
```

### 4.4 Label resources for Helm adoption

Pre-existing resources must be labeled before `helm install` or it will refuse to manage them:

```bash
for ns in commonly commonly-dev; do
  RELEASE=$ns
  for resource in configmap secret; do
    for name in $(kubectl get $resource -n $ns --no-headers \
        -o custom-columns=NAME:.metadata.name | grep -v "helm\|token\|kube"); do
      kubectl label $resource $name -n $ns \
        app.kubernetes.io/managed-by=Helm --overwrite
      kubectl annotate $resource $name -n $ns \
        meta.helm.sh/release-name=$RELEASE \
        meta.helm.sh/release-namespace=$ns --overwrite
    done
  done
  kubectl label namespace $ns app.kubernetes.io/managed-by=Helm --overwrite
  kubectl annotate namespace $ns \
    meta.helm.sh/release-name=$RELEASE \
    meta.helm.sh/release-namespace=$ns --overwrite
done
```

### 4.5 Install nginx-ingress

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install nginx-ingress ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --set controller.service.type=ClusterIP \
  --timeout 180s --wait
```

### 4.6 Helm deploy

```bash
# Pre-create agent-provisioner SA for commonly namespace
kubectl create serviceaccount agent-provisioner -n commonly 2>/dev/null || true
kubectl label sa agent-provisioner -n commonly app.kubernetes.io/managed-by=Helm --overwrite
kubectl annotate sa agent-provisioner -n commonly \
  meta.helm.sh/release-name=commonly \
  meta.helm.sh/release-namespace=commonly --overwrite

# Deploy dev
helm upgrade --install commonly-dev k8s/helm/commonly \
  --namespace commonly-dev \
  -f k8s/helm/commonly/values.yaml \
  -f k8s/helm/commonly/values-dev.yaml \
  --timeout 300s

# Deploy prod
helm upgrade --install commonly k8s/helm/commonly \
  --namespace commonly \
  -f k8s/helm/commonly/values.yaml \
  --timeout 300s
```

---

## Phase 5 — Restore PVC Data

The clawdbot PVCs are `ReadWriteOnce` — only one pod can mount them at a time. Scale down clawdbot first, then use a temp busybox pod.

### 5.1 Restore moltbot.json (clawdbot-config-pvc)

```bash
kubectl scale deployment clawdbot-gateway -n commonly-dev --replicas=0
sleep 15

kubectl apply -n commonly-dev -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: pvc-writer
  namespace: commonly-dev
spec:
  restartPolicy: Never
  containers:
  - name: writer
    image: busybox
    command: ["sleep", "600"]
    volumeMounts:
    - name: config
      mountPath: /state
  volumes:
  - name: config
    persistentVolumeClaim:
      claimName: clawdbot-config-pvc
EOF

kubectl wait --for=condition=Ready pod/pvc-writer -n commonly-dev --timeout=60s

kubectl cp /tmp/k8s-migration/pvcs/commonly-dev-moltbot.json \
  commonly-dev/pvc-writer:/state/moltbot.json

kubectl delete pod pvc-writer -n commonly-dev
kubectl scale deployment clawdbot-gateway -n commonly-dev --replicas=1
```

### 5.2 Restore agent workspaces (clawdbot-workspace-pvc)

Use the same pattern with `claimName: clawdbot-workspace-pvc` mounted at `/workspace`, then:

```bash
for agent in cuz default fakesam liz _master x-curator tarik tom newshound-default socialpulse-default; do
  kubectl cp /tmp/k8s-migration/pvcs/workspace/${agent} \
    commonly-dev/ws-writer:/workspace/${agent}
done
```

### 5.3 Verify moltbot.json

After clawdbot restarts, confirm it loaded correctly:

```bash
CLAWDBOT_POD=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway \
  --no-headers -o custom-columns=NAME:.metadata.name | head -1)
kubectl exec -n commonly-dev $CLAWDBOT_POD -- cat /state/moltbot.json \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('accounts:', list(d['channels']['commonly']['accounts'].keys()))
print('dangerouslyAllowHostHeaderOriginFallback:',
  d.get('gateway',{}).get('controlUi',{}).get('dangerouslyAllowHostHeaderOriginFallback'))
"
```

Expected: 7 accounts listed, `dangerouslyAllowHostHeaderOriginFallback: True`.

---

## Phase 6 — Cutover and Cleanup

### 6.1 Delete old cluster

```bash
gcloud container clusters delete commonly-dev \
  --region us-central1 \
  --project OLD_PROJECT \
  --account OLD_ACCOUNT \
  --quiet --async
```

### 6.2 Clean up local backup

```bash
rm -rf /tmp/k8s-migration
```

---

## Cloudflare Tunnel

The Cloudflare tunnel (`7c15ec02-643c-47cf-babf-8537d6952aa3`) is account-scoped to Cloudflare, not to GCP. It does **not** need to be recreated when migrating GCP projects. The tunnel credentials live in the `cloudflared-commonly-k8s` secret in `ingress-nginx`. As long as that secret is restored, the tunnel connects automatically.

Hostnames routed through the tunnel:
- `app.commonly.me` → `commonly` namespace frontend
- `api.commonly.me` → `commonly` namespace backend
- `app-dev.commonly.me` → `commonly-dev` namespace frontend
- `api-dev.commonly.me` → `commonly-dev` namespace backend

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Pods stuck `Pending` with node affinity error | Node pool labels not set | `kubectl label node <name> pool=dev --overwrite` |
| `helm install` fails: "cannot import namespace" | Namespace lacks helm labels | Label namespace + all resources (Phase 4.4) |
| `helm install` fails: "no ServiceAccount agent-provisioner" | SA must pre-exist for `commonly` namespace | Pre-create SA with helm labels (Phase 4.6) |
| clawdbot `dangerouslyAllowHostHeaderOriginFallback` error | moltbot.json missing from PVC | Restore via temp pod (Phase 5.1) |
| Image pull `NotFound` | GKE node SA lacks GCR access | Grant `roles/storage.objectViewer` (Phase 3.3) |
| PVC attach fails: "Multi-Attach error" | ReadWriteOnce PVC in use by another pod | Scale down clawdbot first (Phase 5.1) |
| Clawdbot build fails: "no such file or directory" | Submitted from repo root; clawdbot must be submitted from its own dir | `gcloud builds submit _external/clawdbot ...` |
