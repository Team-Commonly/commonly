# Staging environment (`commonly-staging`)

Staging is a **second Helm release of this same chart** in its own namespace
(`commonly-staging`), with its own secrets, its own databases, and its own
Cloudflare tunnel. It exists so we can build and deploy on every merge without
touching prod (`commonly-dev`). It is layered on the OSS base:
`helm ... -f values.yaml -f values-staging.yaml` (and the private values at deploy
time). It deliberately does **not** inherit `values-dev.yaml`.

Decision context: R1/R2 in the sprint rulings; ingress isolation is why staging
renders **no Ingress object** (a shared ingress-nginx controller would reload prod
routing) — it is reached only through its own `cloudflared` tunnel straight to
Services.

## Secrets (External Secrets Operator)

ESO syncs secrets from Secret Manager into the staging namespace. The staging
render references **47** keys across three ExternalSecrets — **41 staging-prefixed**
(`commonly-staging-*`, disjoint from prod's `commonly-dev-*`, via
`externalSecrets.keyPrefix: commonly-staging-`) and **6 shared with prod**
(`commonly-*`):

- **api-keys (43)** — 38 staging-prefixed + 5 shared.
  - Of the 38 staging-prefixed: model/search **API keys are copied** from the dev
    values (gemini, openrouter×2, openai, anthropic, brave×2); **JWT, session, and
    internal-connector** secrets (clawdbot-gateway, commonly-bot-runtime,
    litellm-master) are **freshly generated**; the **OAuth** (google/github/x client
    id + secret), **GitHub-App** (id, private-key, installation-id), **codex**, and
    **external-bot** (groupme, telegram) keys are **non-functional placeholders**,
    filled only when those integrations are configured for staging.
  - The 5 shared (`commonly-*`, deliberately not staging-prefixed): the Cloudflare
    Workers-AI token + account id (low power), the Git author name + email
    (harmless), and the shared DeepSeek API key (a spend risk, not access — a
    post-11/1 row swaps it for a capped staging key).
  - **Deliberately NOT shared — the prod GitHub PAT.** `commonly-github-pat` has
    write power over prod repos, and staging auto-deploys every merge (the reckless
    lane), so `githubPat.enabled: false` in values-staging omits the `GITHUB_PAT`
    ref from the staging render entirely (the same principle
    that keeps atlasAdmin off staging). The backend reads GITHUB_PAT lazily and
    degrades (GitHub routes report not-configured) rather than crashing. Staging
    agents that ever need git get a separate fine-grained PAT on a throwaway repo,
    post-11/1.
- **database-credentials (3, all staging-prefixed).** The Postgres role password,
  and the Mongo URI + password (see Databases).
- **postgres-ca-cert (1, shared).** Reuses `commonly-pg-ca-cert`.

No SMTP2GO or Discord keys are **fetched** — both are disabled for staging
(`email.enabled: false`, `discord.enabled: false`), so the `api-keys` ExternalSecret
pulls none of the `commonly-staging-SMTP2GO_*` / Discord values. (The backend env still
carries four *optional* `SMTP2GO_*` secretKeyRefs — the render does reference them — but
with no keys fetched they resolve to nothing, and the backend auto-verifies new signups
rather than waiting on mail it cannot send.)

## Databases

- **Postgres — Aiven (shared instance).** A `commonly_staging` database and a
  **db-scoped login role** that owns it (granted on that database only — **not** an
  admin/superuser role). `backend.env.pgPoolMax: 5`. Created with a throwaway pod on
  the backend image, never by exec into the serving backend
  (`docs/runbooks/ops-runner-and-no-exec-into-backend.md`).

- **MongoDB — in-cluster (NOT Atlas).** A single-replica `mongodb` StatefulSet in
  `commonly-staging` (`mongo:7`, spot pool, 5Gi PVC), with a **staging-only root
  password**. The backend connects to the in-cluster `mongodb` Service.
  **On the spot pool (deliberate):** ADR-015 keeps availability-critical and
  session-holding workloads on the on-demand pool for **prod**; neither applies to a
  resettable staging database, so this stateful db runs on spot. A spot reclaim costs
  only the StatefulSet's PVC-reattach + pod restart (brief downtime), which staging
  tolerates. This is a staging-only exception and does not change the prod rule.
  **Why not Atlas:** the only Atlas credential available on the host is the prod
  user, which carries **`atlasAdmin`** — cluster-wide admin including prod data.
  Staging auto-deploys every merge and is the deliberately reckless lane, so sharing
  that credential is unacceptable (a staging bug or a seat with staging access would
  have admin over prod). Atlas also blocks driver-based user creation, so a scoped
  Atlas user cannot be minted from the host without the Atlas Admin API. The
  in-cluster mongod removes the shared credential entirely; it holds no prod data and
  may be reset freely. (If a managed Atlas staging db is ever wanted, the clean path
  is a `commonly_staging`-scoped readWrite user via the Atlas Admin API/UI — a
  separate, deliberate step, never the admin credential.)

## Reset staging's database

Staging holds no production data and is meant to be wiped freely — but a **restart does
not reset it**. Deleting the pod or `kubectl rollout restart statefulset/mongodb -n
commonly-staging` reattaches the same `mongodb-data-mongodb-0` PVC, so the data
survives. To truly reset you must delete the PVC (or drop the databases).

**Full reset — fresh empty volume:**

```
kubectl scale statefulset/mongodb -n commonly-staging --replicas=0
kubectl delete pvc mongodb-data-mongodb-0 -n commonly-staging
kubectl scale statefulset/mongodb -n commonly-staging --replicas=1
```

The StatefulSet's volumeClaimTemplate provisions a new empty 5Gi PVC, and `mongo:7`
re-initializes the root user from the staging-only password on first boot.

**Drop the app databases only (keep the volume):** run `mongosh` in a throwaway pod on
the `mongo:7` image (never exec into the serving backend), with the root URI injected
from the `database-credentials` secret via `valueFrom.secretKeyRef` so it never lands in
a command line, and call `dropDatabase()` over the non-system databases.

**Postgres (`commonly_staging` on the shared Aiven instance):** drop and recreate the
schema from a throwaway pod with the db-scoped role; never touch anything on the Aiven
instance beyond the `commonly_staging` database.

## ESO authentication

A **namespaced** SecretStore (cluster SecretStore disabled) authenticating via
Workload Identity: the `commonly-staging/eso-gcp-sm` Kubernetes SA is bound to the
shared Secret-Manager-accessor GCP service account, the same pattern prod uses.
Project ID, SA email, and DB hosts are supplied at deploy time from the private
values and are never committed (R12).

## Install preconditions (R2)

Thursday ≥ 19:00 only if **all** hold: node swap verified; the chart prod-render
sha256 is identical on `main` vs the head; the staging render contains **no Ingress
object**; the GKE maintenance exclusion extends through Mon 10-26. Otherwise Friday
18:00 after deploy 3 + review. The first install runs
`helm upgrade --install --create-namespace` (the chart emits no Namespace object,
`createNamespace: false`).
