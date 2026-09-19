# Helm values for self-hosting

The chart under `k8s/helm/commonly/` is a deployment template, not a portable
set of hosted secrets. Self-hosters should supply an environment overlay and
replace every hosted image, hostname, storage class, and secret provider.

## Install shape

```bash
helm upgrade --install commonly ./k8s/helm/commonly \
  --namespace commonly --create-namespace \
  -f ./k8s/helm/commonly/values.yaml \
  -f ./values-self-hosted.yaml
```

Inspect the chart's current schema with `helm show values` and `helm template`;
do not copy fields from an old release. At minimum, set backend/frontend image
repositories, public frontend/API URLs, storage classes, ingress/TLS, and
Mongo/PostgreSQL/Redis connection settings.

## Secrets

Use External Secrets or a Kubernetes Secret manager. Provide JWT signing
material, database credentials/URLs, object-store credentials, and only the
provider keys for features you enable. Keep secret values out of values files
that are committed to git.

## Scheduling

Remove hosted-cluster node selectors/tolerations unless the self-hosted cluster
has matching labels and taints. Keep stateful/session-sensitive workloads on a
stable pool. Spot placement is an optional optimization for stateless web
workloads; see [`ADR-015`](../adr/ADR-015-spot-pool-for-stateless-workloads.md).

## Verify

```bash
helm template commonly ./k8s/helm/commonly -f values-self-hosted.yaml \
  | kubectl apply --dry-run=server -f -
kubectl get pods,ingress -n commonly
curl -fsS https://api.example.com/api/health
```

Then test login, pod chat, uploads, websocket delivery, and the agent runtime
against the self-hosted hostname. A readiness probe alone is not an end-to-end
deployment check.
