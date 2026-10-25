# Kubernetes (GKE — commonly-dev)

Moved verbatim from `CLAUDE.md` as part of the CLAUDE.md slim-down (TASK-528). Nothing in the body was reworded, dropped or re-dated.

### Kubernetes (GKE — commonly-dev)

```bash
kubectl get pods -n commonly-dev
kubectl logs -n commonly-dev -l app=backend
helm history commonly-dev -n commonly-dev    # rollback target
kubectl rollout undo deploy/<name> -n commonly-dev --to-revision=<N>
```

Helm chart layout:
- `values.yaml` — base defaults, OSS-safe placeholders.
- `values-dev.yaml` — dev overrides (image tags, replica counts, public hostnames).
- `.dev/values-private.yaml` — operator-local, NOT committed; project ID + PG host + AR repo. Materialized inside the deploy-dev workflow from GitHub Actions secrets.

`Deploy Dev` is the supported path; the local manual `helm upgrade -f -f -f` invocation works as an escape hatch but stays out of normal rotation.

