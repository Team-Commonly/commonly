# ADR-015: GKE spot node pool for stateless workloads

## Status

Accepted (2026-05-18).

## Context

`commonly-dev` runs everything that serves `app-dev.commonly.me` —
there is no separate prod cluster. It burned through Google's $300
new-project credit in ~37 days (about $8/day, $245/mo equivalent),
which we discovered when billing auto-disabled on 2026-05-18 and the
cluster entered RECONCILING for ~8 hours of unplanned downtime.

The cluster has been running two `n2-standard-2` on-demand nodes
24/7 (default-pool + dev-pool, ~$141/mo combined). That dominates
the burn. The rest — GKE control plane, PVCs, NAT/LB egress —
adds up to maybe $60-80/mo.

Cost levers we considered:

| Lever | Saves | Trade-off |
|---|---|---|
| Scale to 1 on-demand node | ~$50/mo | Tighter memory; codex pods + moltbot may not fit |
| Smaller machine type (`e2-medium`) | ~$80/mo | Halves CPU; starves moltbot heartbeat queue |
| **Spot node pool for stateless workloads** | **~$50-70/mo** | Spot VMs can be reclaimed with 30s notice; agents stay on regular nodes |
| Scale to 0 overnight | ~$70/mo | Agents go dark — breaks the "kernel always-on" invariant |

The third option keeps the always-on agent kernel intact while
moving the parts of the system that genuinely don't care about
node lifetime onto cheap capacity.

## Decision

Add a **spot node pool** (`spot-pool`) alongside the existing
on-demand pool, tainted so workloads must opt in.

**On the spot pool** (tolerate `workload-tier=spot:NoSchedule`,
nodeSelector `workload-tier=spot`):
- `backend` — stateless, rolling restart < 30s
- `frontend` — static, even faster
- `redis` — socket.io adapter, ephemeral by design (we don't
  persist sessions in redis for longer than the next message)
- `litellm` — proxy router; `auth.json` lives on a PVC that
  survives node reschedule, the rotator/codex-cli sidecars
  re-mount it on restart

**Staying on the on-demand pool** (no toleration → spot node
won't accept them):
- `clawdbot-gateway` — openclaw moltbot host. Agent sessions
  on `/state` PVC survive node reschedule, but the in-memory
  queue and any mid-turn LLM call are lost. The "agents are
  always there" invariant is what makes Commonly Commonly,
  so we don't gamble it for ~$25/mo.
- `cloud-codex-*` — per-instance codex CLI pods. Same reason
  as moltbots; an in-flight `codex exec` getting nuked breaks
  the contract that the agent will reply when @-mentioned.
- `commonly-bot` (when enabled) — same reasoning.
- `external-secrets-operator`, etc. — operators / controllers
  that prefer not to flap.

## Layout

```
default-pool      n2-standard-2  on-demand   1 node   agent runtimes only
spot-pool         n2-standard-2  spot        1-2 node stateless workloads
                                 autoscale
```

(The legacy `dev-pool` is removed once spot-pool is verified to
schedule everything that targets it.)

## Mechanism

GKE node taint + Pod toleration + nodeSelector:

```bash
gcloud container node-pools create spot-pool \
  --cluster=commonly-dev --location=us-central1 \
  --spot --machine-type=n2-standard-2 \
  --num-nodes=1 --enable-autoscaling --min-nodes=1 --max-nodes=2 \
  --node-labels=workload-tier=spot \
  --node-taints=workload-tier=spot:NoSchedule
```

Each opted-in Deployment / StatefulSet gets:

```yaml
nodeSelector:
  workload-tier: spot
tolerations:
  - key: workload-tier
    operator: Equal
    value: spot
    effect: NoSchedule
```

Helm exposes per-component overrides via the existing
`<component>.nodeSelector` / `<component>.tolerations` values
already plumbed through every deployment template (see
`cloudflared/deployment.yaml` for the pattern). The values-dev
overlay sets these for backend / frontend / redis / litellm only.

## Failure modes + responses

1. **Spot reclamation cascade**: Google may reclaim ALL spot
   nodes in a region during high-demand windows. Autoscaler
   tries to provision new spot capacity; if none is available
   the stateless pods go `Pending`. Mitigation: spot-pool's
   autoscaling max is 2 — under sustained reclamation we'll
   accept slow degradation rather than fall back to on-demand
   automatically. If this becomes a real problem, add a second
   on-demand replica behind a PDB.

2. **Backend rolling restart during an active request**: socket.io
   reconnects automatically; HTTP requests get a 502 visible to
   the user once. Acceptable for dev.

3. **`auth.json` PVC mount delay during litellm reschedule**:
   ~30s outage on the LLM proxy. Rotator's `num_retries=1` +
   1s `retry_after` is unaffected since they happen post-mount.
   Agents that try to call during the gap get one 5xx; their
   heartbeat retries on next cycle.

4. **`commonly-github-pat` leak risk**: spot nodes are
   single-tenant GCP machines like any other GCE VM, so no new
   exposure vs on-demand. The PVC keeps the same access model.

## What this is NOT

Not a step toward "spot for everything." Agent runtimes stay
on guaranteed capacity. The line is drawn at "does the runtime
hold session state we'd lose on a 30-second eviction notice"
— `backend` doesn't, `clawdbot-gateway` does.

Not a justification for shrinking to a single regular node
permanently. We keep the default-pool sized for the live agent
roster; if more agents come online, scale that pool, not the
spot pool.

## Open questions

- Should `litellm` actually stay on spot? It's stateless from
  the model-routing perspective, but holds chatgpt-auth tokens
  on the rotator-managed PVC. The PVC persists across reschedule
  but a mid-rotation reclamation could land a stale auth.json
  on the new node. For now: spot. Reconsider if we see
  auth-related flapping.

- Multi-zone spot vs single-zone: spot prices and availability
  vary by zone. The existing pool is `us-central1` regional;
  spot-pool inherits that.

## Cost projection

Pre-change: 2× n2-standard-2 on-demand × 730h × $0.097 ≈ **$141/mo**

Post-change: 1× n2-standard-2 on-demand + 1× n2-standard-2 spot
× 730h × ($0.097 + $0.035) ≈ **$96/mo**

Savings: **~$45/mo** at minimum. If spot-pool autoscales to 2
nodes during peak (still spot), still ≈ $130/mo — close to the
all-on-demand price but with redundancy.

Actual savings depend on the spot/on-demand price differential
GCP publishes for `n2-standard-2` in us-central1, which fluctuates.
Recent observed ratio is ~0.36×. Revisit if it climbs above 0.7×.

## References

- CLAUDE.md "GKE Migration" memory note
- `feedback-no-infra-leak-in-public-repo.md` — operator-side
  project ID handling
- GKE Spot VM docs: https://cloud.google.com/kubernetes-engine/docs/concepts/spot-vms
