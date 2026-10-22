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
    ref from the staging render entirely (Cofounder's ruling — the same principle
    that keeps atlasAdmin off staging). The backend reads GITHUB_PAT lazily and
    degrades (GitHub routes report not-configured) rather than crashing. Staging
    agents that ever need git get a separate fine-grained PAT on a throwaway repo,
    post-11/1.
- **database-credentials (3, all staging-prefixed).** The Postgres role password,
  and the Mongo URI + password (see Databases).
- **postgres-ca-cert (1, shared).** Reuses `commonly-pg-ca-cert`.

No SMTP2GO or Discord keys — both are disabled for staging (`email.enabled: false`,
`discord.enabled: false`), so the render references none.

## Databases

- **Postgres — Aiven (shared instance).** A `commonly_staging` database and a
  **db-scoped login role** that owns it (granted on that database only — **not** an
  admin/superuser role). `backend.env.pgPoolMax: 5`. Created with a throwaway pod on
  the backend image, never by exec into the serving backend
  (`docs/runbooks/ops-runner-and-no-exec-into-backend.md`).

- **MongoDB — in-cluster (NOT Atlas).** A single-replica `mongodb` StatefulSet in
  `commonly-staging` (`mongo:7`, spot pool, 5Gi PVC), with a **staging-only root
  password**. The backend connects to the in-cluster `mongodb` Service.
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
