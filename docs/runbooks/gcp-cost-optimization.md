# GCP cost review runbook

This is the operator checklist for the `commonly-dev` GKE cluster. Treat live
billing export and live cluster state as authoritative; numbers copied from an
old incident are not a current budget.

## Invariants

ADR-015 places stateless workloads (`backend`, `frontend`, `redis`) on the
spot pool. Agent runtimes and other stateful/session-sensitive workloads stay
on the regular runtime pool. System components stay on the system pool. A
spot preemption is acceptable for a stateless web request, not for a runtime
holding a conversation or credential.

Check placement and pool sizing before changing anything:

```bash
kubectl get pods -n commonly-dev \
  -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName'
kubectl get nodes --show-labels
kubectl top nodes
gcloud container node-pools list --cluster commonly-dev \
  --location us-central1 --project <operator-project>
```

Keep project IDs, billing account IDs, and credentials out of the repository.

## Audit order

1. Read the billing export by service and SKU for the last 7 and 30 days.
2. Compare compute usage with requested CPU/memory and autoscaling bounds.
3. Check persistent disks and PVCs for abandoned capacity.
4. Check Artifact Registry retention and image growth.
5. Check Cloud Logging volume and egress before proposing exclusions.

The BigQuery billing export is the source of truth. A cluster estimate is a
diagnostic, not a bill:

```sql
SELECT service.description, SUM(cost) AS cost, currency
FROM `<project>.<dataset>.gcp_billing_export_v1_*`
WHERE _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY service.description, currency
ORDER BY cost DESC;
```

## Safe changes

- Adjust a stateless pool only after checking requests, limits, and the
  autoscaler ceiling.
- Use Artifact Registry cleanup policies for untagged images and keep enough
  SHA-tagged versions for the rollback window.
- Reduce noisy logging only after confirming the excluded records are not
  needed for incident response.
- Keep the runtime pool on-demand unless the runtime explicitly tolerates
  eviction and loses no session state.

For every change, record the measured cost driver, the availability trade-off,
the rollback command, and the observation window. Prefer one reversible change
at a time.

## Recovery and rollback

If a cost change causes scheduling or runtime instability, restore the prior
node-pool, deployment, or retention setting and watch rollout completion:

```bash
kubectl rollout status deployment/backend -n commonly-dev --timeout=120s
kubectl rollout status deployment/litellm -n commonly-dev --timeout=120s
kubectl get events -n commonly-dev --sort-by=.lastTimestamp | tail -40
```

Never delete a cluster, repository, disk, or secret as a cost experiment.
Destructive cleanup waits for an explicit retention decision and an export or
backup check.

See [`ADR-015`](../adr/ADR-015-spot-pool-for-stateless-workloads.md) for the
placement decision and the deployment docs for normal rollout procedures.
