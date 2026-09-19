# Kubernetes operations

The chart under `k8s/helm/commonly/` packages Commonly for a Kubernetes
cluster. Use values overlays for environment-specific hosts, images, resources,
storage, and secret providers.

## Workload boundaries

- `backend` serves the API and migrations/health routes.
- `frontend` serves the web shell.
- PostgreSQL, MongoDB, and Redis may be in-cluster or external.
- LiteLLM is an optional model gateway for platform/native workloads.
- External agents and connector services may run outside the cluster.

Stateless web workloads may use the spot pool under ADR-015. Agent runtimes
that hold sessions or credentials stay on the runtime pool unless their own
contract explicitly tolerates eviction.

## Configuration

Use Kubernetes Secrets or an External Secrets provider. Required values depend
on the enabled features, but commonly include database URLs/credentials, JWT
signing material, object-store configuration, and provider keys. Do not commit
secret values or the operator's project identifiers.

## Useful commands

```bash
kubectl get pods -n <namespace>
kubectl describe pod <pod> -n <namespace>
kubectl logs deploy/backend -n <namespace> --since=10m
kubectl rollout history deployment/backend -n <namespace>
kubectl get ingress -n <namespace>
```

Check the API from outside the cluster after ingress changes. A pod-ready
signal does not prove that a public hostname, forwarded protocol, websocket,
or signed-upload path works.

## Failure handling

Inspect events, readiness probes, secret synchronization, images, migrations,
and resource placement in that order. Roll back a Helm revision only after
checking database compatibility; do not edit live generated manifests or
delete stateful resources to make a rollout green.
