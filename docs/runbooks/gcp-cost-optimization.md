# GCP cost optimization runbook — commonly-dev

How to investigate, decide, and apply cost optimizations on the
commonly-dev GKE cluster without trading away stability or scalability.
Reference doc; pull this before any cluster sizing / billing question.

---

## Cost-driver audit framework

Before touching anything, get the breakdown. Five buckets account for
virtually all spend:

1. **Compute (VMs)** — node pool sizes × machine type × on-demand vs spot
2. **Persistent disks** — boot disks (per node) + PVCs
3. **Artifact Registry storage** — Docker image bytes (grows monotonically without retention)
4. **Cloud Logging** — billable past 50 GiB/mo free tier; agent runtimes are chatty
5. **Egress** — internet egress + inter-zone (LiteLLM → OpenAI/Anthropic + agent runtime → outbound LLM)

Quick audit script lives in this skill's recipes section below. Always
reconcile estimates against the **billing export to BigQuery** — that's
the only authoritative source. See [Billing export setup](#billing-export-setup).

### Common surprises

- **Regional GKE cluster fee**: `$0.10/hr` per cluster excluding the first zonal cluster per billing account. `commonly-dev` is zonal (us-central1-a) → free. Don't switch to regional unless HA is worth $73/mo.
- **Default-pool oversizing**: the untainted system-pod pool defaults to whatever the cluster was created with. n2-standard-2 is overkill for ~1.5 GB of kube-system + ESO; verify actual usage with `kubectl top node`.
- **AR with no retention**: every `Deploy Dev` adds 4 SHA-tagged image versions × ~400 MB each = ~1.5 GB/deploy. At 5 deploys/day that's ~225 GB/mo.

---

## Current footprint (as of 2026-05-22)

| Bucket | Detail | Approx $/day |
|---|---|---|
| default-pool (1× n2-standard-2 on-demand) | System pods only — DNS, ESO, fluent-bit, metrics-server, etc. | $2.33 |
| dev-pool (1× n2-standard-2 on-demand, autoscale 1-3) | Agent runtimes — clawdbot-gateway, cloud-codex-*, commonly-bot, litellm. Taint `pool=dev:NoSchedule`. | $2.33 |
| spot-pool (1× n2-standard-2 spot, autoscale 1-2) | Stateless workloads — backend, frontend, redis. Taint `workload-tier=spot:NoSchedule`. ADR-015. | $0.70 |
| Boot + PVC disks (~244 GB pd-balanced) | 3 boot disks + 5 PVCs | $0.82 |
| Artifact Registry (`docker` repo) | 4 image packages × growing SHA tags. Cleanup policy applied 2026-05-22 (see below). | $0.57 |
| Cloud Logging + monitoring + egress | No exclusion filters configured. Verbose agent runtime logs. | ~$2.25 (est) |
| **Total** | | **~$9.00** |

Workload placement is verifiable any time with:

```bash
kubectl get pods -n commonly-dev -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,TOLERATIONS:.spec.tolerations[*].key'
```

Expected per ADR-015: backend/frontend/redis on `spot-pool`, agent
runtimes on `dev-pool`, system pods on `default-pool`.

---

## Optimizations applied

### ADR-015 — spot-pool for stateless workloads (2026-05-04)

Moved backend, frontend, redis from on-demand `dev-pool` to spot
`spot-pool`. Saved ~$50/mo. Agent runtimes (clawdbot, cloud-codex,
commonly-bot, litellm) stay on `dev-pool` because spot preemption
mid-session would lose conversation state. See `ADR-015-spot-pool-for-stateless-workloads.md`.

Verification — see kubectl command above. If a stateless pod drifts off
spot-pool, check the deployment's `nodeSelector` / `tolerations`.

### Artifact Registry retention (2026-05-22)

Applied a two-rule cleanup policy to the `docker` repo:

```json
[
  {"name": "delete-untagged-after-7d",
   "action": {"type": "Delete"},
   "condition": {"tagState": "UNTAGGED", "olderThan": "604800s"}},
  {"name": "keep-last-30-tagged-per-image",
   "action": {"type": "Keep"},
   "mostRecentVersions": {"keepCount": 30}}
]
```

Apply via:

```bash
gcloud artifacts repositories set-cleanup-policies docker \
  --location=us-central1 --project=commonly-493005 \
  --policy=/tmp/ar-cleanup-policy.json
```

Cleanup runs async over ~6-12 hours. Expected: 179 GB → ~50-60 GB.
Saves ~$10-15/mo. **Reversible** by rebuilding from git SHA, since the
deploy-dev workflow re-tags from `HEAD`. Helm rollback within last 30
deploys still works (the tag is still there).

### Pool autoscaling (2026-05-22)

All three pools now autoscale:

| Pool | Min | Max | Why |
|---|---|---|---|
| default-pool | 1 | 2 | HA for system pods on cluster events |
| dev-pool | 1 | 3 | Agent runtime fan-out as fleet grows |
| spot-pool | 1 | 2 | Stateless workload bursts |

Baseline cost unchanged (all sit at min=1 today). Value materializes
when load exceeds a single node — cluster autoscaler adds nodes
automatically; pays only when scaled out.

Apply via:

```bash
gcloud container clusters update commonly-dev \
  --region us-central1 --project commonly-493005 \
  --enable-autoscaling --node-pool <pool> --min-nodes <m> --max-nodes <M>
```

---

## Decisions explicitly rejected

### default-pool → e2-medium (rejected)

Would save ~$50/mo but system pods request 1034m CPU vs e2-medium's
1000m sustained. Cluster events (rolling restarts, large deploys)
could throttle kube-dns / kube-proxy / ESO. Fails the stability bar.

### default-pool → e2-standard-2 (deferred)

Same shape as n2-standard-2 at ~30% lower cost. Saves ~$22/mo. Low
risk. Deferred until billing export gives 1-2 weeks of data — want
evidence before touching compute.

### Aggressive Cloud Logging exclusions (deferred)

Could save ~$15-30/mo by filtering healthz probes and heartbeat-OK
log lines. Deferred for the same reason — need billing data to confirm
logging is actually the cost driver before reducing observability.

---

## Billing export setup

The only authoritative cost source is the billing-export BigQuery
dataset. Setup is **one manual click** because Google never exposed a
gcloud command for the export-switch.

1. Dataset (one-time, scriptable):
   ```bash
   bq --location=us-central1 mk --dataset \
     --description="Cloud Billing daily export for cost visibility" \
     commonly-493005:billing_export
   ```
2. Cloud Console UI (manual): visit `https://console.cloud.google.com/billing/<ACCOUNT_ID>/export`, pick `Daily cost detail → Edit settings`, choose project `commonly-493005`, dataset `billing_export`, save.
3. First data lands ~24h later. Tables auto-created: `gcp_billing_export_v1_<ACCOUNT_ID>`.

Sample query for daily $ by service:

```sql
SELECT service.description, SUM(cost) AS cost_usd, currency
FROM `commonly-493005.billing_export.gcp_billing_export_v1_*`
WHERE _PARTITIONTIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
GROUP BY service.description, currency
ORDER BY cost_usd DESC
```

---

## Decision framework — when to act on a cost signal

Before any cost optimization, answer all three:

1. **What's the actual cost driver?** Estimate from `gcloud` + cluster
   inspection, then verify against billing export. Never optimize on a
   hunch.
2. **What does this trade for stability?** System pods can't throttle.
   Spot pods can be preempted with 30s notice — anything stateful stays
   on-demand.
3. **What does this trade for scalability?** Right-sizing baseline is
   fine; capping the ceiling is not — use autoscaling, not fixed sizes.

If a change reduces cost AND maintains both bars: do it.
If it fails either bar: don't, even if savings are tempting.

---

## Audit recipe

Drop-in script to capture the current state in one go:

```bash
echo "=== pool sizing + autoscaling ==="
gcloud container node-pools list --cluster commonly-dev --location us-central1 \
  --project commonly-493005 \
  --format='table(name,config.machineType,config.spot,autoscaling.enabled,autoscaling.minNodeCount,autoscaling.maxNodeCount)'

echo "=== workload placement (verifies ADR-015 invariant) ==="
kubectl get pods -n commonly-dev -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,TOLERATIONS:.spec.tolerations[*].key'

echo "=== AR repo size + cleanup policy ==="
gcloud artifacts repositories describe docker --location=us-central1 \
  --project=commonly-493005 --format='yaml(sizeBytes,cleanupPolicies)'

echo "=== node usage vs requested ==="
kubectl top nodes
for n in $(kubectl get nodes -o name); do
  echo "--- $n ---"
  kubectl describe $n | grep -A 5 'Allocated resources' | head -6
done
```

---

## Sources

- ADR-015 — spot pool for stateless workloads
- `feedback-no-infra-leak-in-public-repo` memory — what stays out of public repo
- 2026-05-22 cost analysis session — `project-2026-05-22-gcp-cost-optimization.md`
