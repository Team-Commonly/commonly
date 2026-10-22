# Never run ad-hoc scripts by exec into the serving backend — use `ops-runner`

## Rule

Do **not** run operator scripts with `kubectl exec deploy/backend -c backend -- node -`
(or any exec that spawns a process inside the `backend` container). Use the
isolated `ops-runner` pod instead:

```
kubectl exec -n commonly-dev deploy/ops-runner -- env NODE_PATH=/app/node_modules node - < your-script.js
```

`ops-runner` carries the **same image, env, and secret mounts as backend**
(so `process.env.MONGO_URI`, `PG_*`, `JWT_SECRET`, the `api-keys` secret, the
Postgres CA cert, etc. are all present), but it runs `sleep infinity`, serves no
traffic, has no readiness/liveness probe, and sits on the **spot pool** — a
different node from the on-demand `dev` pool where `backend` and `redis` live.
So a heavy or runaway operator script competes with nothing that serves users.

## Why — the mechanism

`kubectl exec deploy/backend -c backend -- node -` starts your Node process
**inside the backend container's cgroup and CPU limit**. A "read-only" Mongo
query is still a Node process competing for the same CPU shares as the backend's
HTTP server and its readiness probe. The backend runs **one replica**, so there
is no second copy to absorb the load: if the exec'd process starves the probe,
the pod flips `NotReady`, the ingress drops it from its upstreams, and every API
request 503s until it recovers.

## The incident that earned this (2026-10-22 ~11:42Z)

A burst of in-cluster `kubectl exec deploy/backend … node -` reads (operator
scripts: agent board-wake / membership / pod-config writes, plus incident reads)
ran on node `5nmv` around 11:42Z. k8s events show `backend` failing
`GET /api/health/ready` with `context deadline exceeded` at 11:42:37/42/47 and
11:43:18Z, and `litellm` on the same node failing its readiness at 11:42:47Z —
two unrelated pods flapping at the same instant = node-level CPU pressure, not an
app bug. While backend was unready the ingress had no upstream, so ~10 seats got
`503 Service Temporarily Unavailable` (11:42:47–51Z) and the
"5xx count > 9 per 10m" alert fired (resolved 11:56Z). The backend never
crashed (0 restarts) — it was starved, not broken. The node swap that replaced
`5nmv` does **not** fix this: backend is still one replica, so the next heavy
exec on its node can do it again. `ops-runner` is the fix.

## What `ops-runner` is

- `k8s/helm/commonly/templates/ops/ops-runner-deployment.yaml` — a Deployment
  (`replicas: 1`) using the backend image with `command: ["/bin/sh","-c","sleep infinity"]`.
- Env + volumeMounts are **mirrored verbatim from `backend-deployment.yaml`** —
  there is a `KEEP IN SYNC` banner in both files. (They are mirrored rather than
  DRY-extracted into a helper because the backend env block contains blank lines
  that `nindent` would re-indent, which would change backend's rendered bytes.)
- Gated by `.Values.opsRunner.enabled` (default **true**; `values-staging.yaml`
  sets it **false**). Pinned to the spot pool in `values-dev.yaml`. No Service,
  no Ingress, no probes. Small requests (50m / 128Mi).

## Operator checklist

- Reads and one-off writes to Mongo/PG: run them in `ops-runner`, never backend.
- Keep them short and sequential; even on `ops-runner`, don't fan out a burst.
- The seats' CLI runtime still talks to the API normally — this rule is only
  about operator shell scripts that `exec … node -` into a cluster pod.
