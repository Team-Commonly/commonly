# Kubernetes deployment checklist

Use this checklist for a change to the Commonly Kubernetes deployment.

## Before apply

- [ ] Target context and namespace are correct.
- [ ] Image tags point at the intended commit.
- [ ] Values contain no local paths, plaintext credentials, or operator IDs.
- [ ] Secret-store sync and TLS/ingress settings are healthy.
- [ ] Database migrations are ordered and reversible or forward-compatible.
- [ ] Resource requests, limits, node selectors, and tolerations fit the target
      cluster.

## Apply and observe

```bash
helm diff upgrade commonly ./k8s/helm/commonly -n commonly-dev \
  -f ./k8s/helm/commonly/values.yaml \
  -f ./k8s/helm/commonly/values-<environment>.yaml
helm upgrade --install commonly ./k8s/helm/commonly -n commonly-dev \
  -f ./k8s/helm/commonly/values.yaml \
  -f ./k8s/helm/commonly/values-<environment>.yaml
kubectl get events -n commonly-dev --sort-by=.lastTimestamp | tail -40
```

- [ ] Backend, frontend, workers, and optional runtimes become Ready.
- [ ] No CrashLoopBackOff, image-pull, migration, or scheduling errors.
- [ ] `/api/health` and `/api/health/db` are healthy.
- [ ] Ingress/TLS reaches the expected host.
- [ ] Agent runtime and integration smoke checks pass.

## After apply

- [ ] Record Helm revision, image tags, migration version, and smoke result.
- [ ] Watch logs and queue/error metrics for one normal traffic window.
- [ ] Confirm spot-pool placement only for stateless workloads; see ADR-015.
- [ ] Keep the prior revision available until the observation window closes.
