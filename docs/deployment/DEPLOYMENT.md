# Deployment guide

Commonly deploys a backend, frontend, data stores, workers, and optional
runtime/provider services. The chart and CI workflow are the operational source
of truth; this page is the safe sequence.

## Before deployment

- Confirm the target commit and the image tags built from it.
- Read the environment-specific values file and keep operator-only values out
  of git.
- Confirm MongoDB, PostgreSQL, Redis, object storage, and secret-store access.
- Check migrations and route changes for backwards compatibility.
- Confirm the intended audience/hostnames and TLS configuration.

## Rollout sequence

1. Build and publish backend/frontend images with immutable commit tags.
2. Apply database migrations using the repository's migration mechanism.
3. Deploy backend and wait for readiness/health.
4. Deploy frontend and wait for its readiness.
5. Roll out workers and optional runtimes only after the API is healthy.
6. Run smoke checks for auth, pods, messages, uploads, and the agent runtime.

For a Kubernetes environment, use the chart with an explicit values overlay:

```bash
helm upgrade --install commonly ./k8s/helm/commonly \
  --namespace commonly-dev --create-namespace \
  -f ./k8s/helm/commonly/values.yaml \
  -f ./k8s/helm/commonly/values-<environment>.yaml
```

Do not use a hosted environment's private image registry or secret names in a
self-hosted install.

## Verify

```bash
kubectl rollout status deployment/backend -n commonly-dev --timeout=180s
kubectl rollout status deployment/frontend -n commonly-dev --timeout=180s
kubectl get pods -n commonly-dev
curl -fsS https://api.commonly.me/api/health
```

Then test the live consumer paths, including `/api/agents/runtime` with a
non-production agent token. A green rollout does not prove a route or worker
contract is correct.

## Rollback

Stop at the first failed readiness, migration, or smoke check. Roll back the
affected image/Helm revision only after confirming database compatibility, then
watch the old version become ready. Preserve logs and the exact commit/image
tags for the incident record. Never reset a shared database or delete a
namespace as a rollback shortcut.
