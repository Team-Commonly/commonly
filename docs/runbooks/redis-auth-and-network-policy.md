# Redis auth, and when to add NetworkPolicy

## Redis AUTH (shipped)

Redis requires a password (`requirepass`) from every client. The password is
generated into GCP Secret Manager and delivered via ESO (`api-keys` →
`redis-password`), never committed or printed.

- Toggle: `redis.auth.enabled` — `false` in `values.yaml` (OSS chart + local dev
  run with no password), `true` in `values-dev.yaml` and `values-staging.yaml`.
- Redis loads `requirepass` from a generated `/tmp/redis.conf` (not
  `--requirepass`, so the password never appears in process args), hands off to
  `docker-entrypoint.sh` so it still drops to the `redis` user, and the
  `redis-cli` probes authenticate via `REDISCLI_AUTH`.
- Clients pass `password: process.env.REDIS_PASSWORD || undefined` (undefined =
  no AUTH, so the auth-off path is unchanged). Clients: backend (socket.io
  adapter + health), ops-runner. litellm has no redis; commonly-bot has none.
- The generated password must be hex or alphanumeric (it goes into the conf
  unquoted) — `openssl rand -hex 32`.
- Rollout: one helm upgrade carries the Secret, redis `requirepass`, and every
  client's `REDIS_PASSWORD` together, with a brief adapter reconnect window.

## NetworkPolicy — deferred, NOT dropped

With redis auth in place, every in-cluster service has its own auth, and today
no untrusted workload runs in the cluster. NetworkPolicy (fencing redis — and
the other ClusterIP services — to only the pods that need them) is the
defense-in-depth second step, deferred until it is actually needed.

**Trigger — do this, in a maintenance window, BEFORE turning on the first
in-cluster pod that runs agent- or user-controlled code:**

- a cloud-codex agent (ADR-014 reactivating), or
- a Tier-2 run-code sandbox, or
- Steel/Walker browsing beyond `commonly.me`.

Any of those puts code that is not ours on the flat cluster network, where every
ClusterIP service is reachable. The password stops credential-less access; a
NetworkPolicy stops the untrusted pod from reaching services it has no business
touching at all.

**Cost / impact (no change made yet):** enforcement needs a CNI that honors
NetworkPolicy — the GKE Network Policy add-on (Calico) via
`--enable-network-policy`, or Dataplane V2. Toggling it on this existing Standard
cluster triggers a **rolling node recreation** (every pod reschedules; expect
brief shell 503s as redis reschedules, per ADR-015). No GCP add-on fee; the cost
is a per-node agent (`calico-node` DaemonSet, ~100–200m CPU + ~100–200Mi RAM per
node; ~0.5–1 vCPU + 0.5–1Gi across the fleet). Confirm the live cluster type
before any change.

See the in-cluster service-auth audit (SRE, 2026-11-04) for the full inventory.
