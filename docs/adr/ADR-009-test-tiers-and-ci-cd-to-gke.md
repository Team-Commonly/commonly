# ADR-009: Test tiers and CI/CD to GKE

**Status:** Draft — 2026-04-19
**Author:** Sam Xu
**Companion:** [`REVIEW.md`](../../REVIEW.md), [`docs/deployment/KUBERNETES.md`](../deployment/KUBERNETES.md)

---

## Context

Two related gaps surfaced while landing ADR-002 Phase 1b-a (#216):

**1. Test tiers are muddled.** The repo calls a suite "integration" and wires `INTEGRATION_TEST=true` in CI with real `mongo:7` + `postgres:16` service containers — but `__tests__/utils/testUtils.setupMongoDb()` ignores `MONGO_URI` and spins up `MongoMemoryServer` anyway. The service containers sit idle. Tests that are named integration don't, in fact, hit real databases. Meanwhile `smoke-test.yml` runs the kind cluster only on post-merge `main` (via `workflow_run`), so PRs never get cluster signal. The result: a PR can pass "integration tests" despite its query not working against real Mongo/PG, and we find out on dev.

**2. Deploys are manual and cloud-agent-hostile.** Deploying dev today is a human-driven sequence on a laptop: `docker build`, `docker push` to `us-central1-docker.pkg.dev/...`, bump the image tag in `values-dev.yaml`, run `helm upgrade` with three `-f` flags including the uncommitted `values-private.yaml`. CLAUDE.md §Build & Deploy documents this. It works for Lily on her machine; it doesn't work for a cloud-based Claude session (no docker daemon, no gcloud auth, no access to `values-private.yaml`) and it's brittle for humans too (the three-`-f` rule with `values-private.yaml` is a known foot-gun that's bitten the team before).

The two gaps interact. A merge that passes current CI can still break dev at deploy time — and the agent that made the change can't trigger or observe the deploy, so verification falls to whoever pulls the latest image tag next. This is the "cloud-agent-hostile" bit from the ADR-002 Phase 1b-a review: if we want agents doing real work against real clusters, the loop has to close without a human in the middle.

---

## Decision

Adopt a four-tier test taxonomy with explicit names and explicit PR gating, and wire a workflow-triggered GKE deploy path that neither human nor agent has to run locally.

### Test tiers

| Tier | Name | What it exercises | Runs on | Gate |
|---|---|---|---|---|
| 0 | **Unit** | In-memory everything; route handlers with mocked models; single-module tests | every push | required |
| 1 | **Service** | Real Mongo + Postgres (service containers); model queries, regex semantics, ObjectId coercion, PG ILIKE | every push | required |
| 1.5 | **Chart lint** | `helm template` + `kubeconform` / `kubeval` against the rendered manifests | every push | required |
| 2 | **Cluster smoke** | Full Helm install on kind; pods come up, health probes pass, HTTP smoke against ingress | PRs touching `k8s/`, `Dockerfile`, `dev.sh cluster`; `workflow_dispatch` | required on eligible paths |
| 3 | **Dev-env smoke** | Real GKE `commonly-dev` after deploy-on-merge; HTTP probes against `api-dev.commonly.me`; auto-rollback on failure | merge to `main` | informational (rolls back on fail) |

**Tier 1 is the rename most of the audit turns on.** The current "integration" suite becomes Tier 1 *and* actually uses the service containers, not `MongoMemoryServer`. `setupMongoDb()` gets a `useRealServices` branch that `mongoose.connect(process.env.MONGO_URI)` when `INTEGRATION_TEST=true`, and leaves the memory server for Tier 0. `pg-mem` similarly falls back to a real `pg.Pool` against the `postgres:16` container when the env says so. Nothing else in the test body changes — same fixtures, same assertions.

**Tier 1.5 (chart lint) is new** and closes a real gap: a PR that adds `process.env.NEW_REQUIRED_FLAG` to `backend/` without a matching chart update passes Tier 0 and Tier 1 (neither renders Helm) and doesn't trigger Tier 2's path filter (only `backend/` changed). It merges green and breaks dev on Phase 3 deploy. `helm template k8s/helm/commonly -f values.yaml -f values-dev.yaml | kubeconform` runs in < 30s, catches missing values / schema / required-env-var-in-ConfigMap drift, and is cheap enough to run on every push. Keeps Tier 2 as the "real cluster" signal and lets chart-lint be the always-on first line of defense.

**Tier 2 is clarified, not new.** `smoke-test.yml` already spins up kind and runs `./dev.sh cluster test`. We change the trigger so it runs on PRs that touch deployment surfaces (path-filtered `on.pull_request.paths`) and keep the post-merge run. Every PR that *could* break a deploy gets cluster signal before merge.

**Tier 3 is new and depends on the deploy path below.**

### CI/CD to GKE

**Auth: Workload Identity Federation only.** No service account JSON keys in GitHub secrets. One WIF pool in the dev GCP project federates trust to the `Team-Commonly/commonly` repo; GitHub Actions exchanges its OIDC token for a short-lived GCP access token via `google-github-actions/auth@v2`. Keys never leave GCP. (Project ID is supplied to the workflow at run-time via the `DEV_GCP_PROJECT_ID` GitHub secret — it is not committed anywhere in this repo.)

**Triggers:**
- **Dev**: merge to `main` → build images → push to `us-central1-docker.pkg.dev/...` → `helm upgrade commonly-dev` → Tier 3 smoke against `api-dev.commonly.me` → `helm rollback` on smoke failure.
- **Prod**: tag push `v*.*.*` → identical pipeline against `commonly-prod`, gated by a GitHub environment with one-reviewer approval. No automatic prod deploys.

**Values handling — the `values-private.yaml` problem.**

Current state: `values-private.yaml` lives only on Lily's laptop at `/home/xcjam/workspace/commonly/.dev/values-private.yaml`. It holds the real GCP project ID, PG host, and image repo overrides. Anyone else running `helm upgrade` either doesn't have it (deploy fails) or recreates it from memory (drift).

Target state: the *secret* content in `values-private.yaml` moves to GCP Secret Manager and is pulled into the cluster by ESO (which already owns `api-keys` per CLAUDE.md §Agent Runtime). The *config* content (GCP project ID, PG host, image repo) moves into a committed `values-dev.yaml` / `values-prod.yaml` — these are not secrets and hiding them just makes the repo unusable to new contributors. One uncommitted file disappears; three committed files + ESO handle what it used to.

**Image tags.** Workflow sets image tag to `${sha}` (short SHA) and passes it via `--set image.tag=...` on helm upgrade, not by editing `values-dev.yaml`. That keeps the workflow git-clean (no auto-commit back to main), keeps `values-dev.yaml` reviewable, and makes rollback a matter of `helm upgrade --set image.tag=<previous-sha>` rather than a values-file revert.

**Rollback.** Tier 3 smoke is the gate. On failure, the workflow rolls the release back to the **last known-good revision** tracked in a Helm chart annotation (`commonly.me/last-good-revision`) that the workflow stamps on every passing deploy. This avoids two failure modes of naive `helm rollback commonly-dev 0`: (1) the first-ever deploy has no prior revision to roll back to, so the workflow short-circuits to "fail loudly, don't auto-rollback" when `helm history` has one entry; (2) a second failing deploy could otherwise roll back to the first failing deploy's revision rather than the last good one. The 3-strikes escalation triggers a CI failure and an auto-opened GitHub issue when the last-known-good pointer gets stale (three consecutive rollbacks against the same pointer).

---

## Consequences

### Positive

- **PRs get signal against real services.** Tier 1 catches the class of bug where a query works against `MongoMemoryServer` but not real Mongo (index behavior, regex semantics, ObjectId coercion). ADR-002 Phase 1b-a's review would have caught `findOne` false-deny and the profile-picture URL-shape mismatch during CI, not during inline review — same caliber of bug, found earlier.
- **Cloud-agent workflow closes.** A Claude session on `claude.ai/code` can now: open a PR → CI runs Tier 0/1/2 → merge → Tier 3 deploys dev and reports back via PR comment or commit status → agent observes the outcome via `mcp__github__pull_request_read`. No laptop required.
- **Deploy is auditable.** Every image tag on `commonly-dev` traces to a commit SHA and a workflow run. Current state ("who pushed the `20260417212525-r2` image?") becomes "click the deploy run."
- **No long-lived GCP keys.** WIF removes the SA JSON from GitHub secrets. If a repo collaborator goes rogue, they can't steal a deploy credential — they'd need to modify a workflow and get it merged.
- **New contributors can deploy.** The `values-private.yaml` ritual goes away. `./dev.sh` + a committed `values-dev.yaml` is enough to understand what ships.

### Negative / risks

- **Tier 1 run time.** Hitting real Mongo + PG adds seconds per test. If the full Tier 1 suite runs > 5 min the signal-to-friction ratio drops. Mitigation: keep Tier 0 fast (< 30s) so PRs fail fast on trivial breaks before paying Tier 1 cost.
- **Cluster smoke (Tier 2) latency.** kind brings up ~20 min. Gating only on deployment-surface paths keeps most PRs free of it; PRs that need it pay the cost because the alternative is breaking dev.
- **WIF setup is one-time but irreversible-ish.** Once we cut over, dropping back to SA keys is a conscious decision, not a default. This is fine — the whole point — but worth noting.
- **Auto-rollback hides failures.** If Tier 3 rolls back automatically, a subtle prod-only bug could ping-pong between deploy attempts. Mitigation: three consecutive rollbacks on the same commit → workflow escalates to a status-check failure and pages whoever merged.
- **Prod deploy is now one approval click away.** The one-reviewer gate is minimal; we may want two reviewers or an SRE-team requirement before `v1.0.0` ships. Set per-environment in GitHub; costs nothing to tighten later.

### Security notes

- **OIDC audience.** WIF provider must scope to `repo:Team-Commonly/commonly:ref:refs/heads/main` (dev) and `repo:Team-Commonly/commonly:environment:prod` (prod). A forked PR cannot mint a token for either.
- **Image registry push scope.** The WIF-backed SA has `roles/artifactregistry.writer` on the `docker` repo only. No project-wide admin.
- **Helm upgrade scope.** Deploy SA has only `roles/container.clusterViewer` at the IAM layer (auth to any cluster, no mutation). Real deploy permissions come from a Kubernetes `ClusterRoleBinding` of `edit` scoped per cluster — revoking `commonly-dev` access is `kubectl delete clusterrolebinding deploy-github` on that cluster, with no effect on `commonly-prod` or any future cluster.
- **No secrets echoed in logs.** `set -x` banned in the deploy workflow; `::add-mask::` used for any intermediate token output.
- **Tier 3 probes are unauthenticated only (Phase 4 scope).** `GET /api/health/live` and `GET /api/health/ready` cover the "did the pod come up and can it reach Mongo + Postgres" question — which is the overwhelming majority of deploy regressions. Authenticated round-trips (login + domain-endpoint call) need a credential story (dedicated smoke account, its User row in Mongo, ESO-rotated secret, workflow retrieval of the credential) that isn't resolved yet; deferred to a later phase so it doesn't block Phase 4.

---

## Alternatives considered

### A. Keep `MongoMemoryServer` in "integration," add a separate "real-services" tier on top.

Rejected. We'd end up with five tiers, two of which ("integration", "real-services") sound identical to anyone who hasn't read this ADR. Rename-in-place is clearer.

### B. Cloud Build instead of GitHub Actions.

Rejected. Per CLAUDE.md §Build & Deploy: "Cloud Build org policy blocks AR uploads — use local Docker instead." The org policy is non-negotiable at this scale; GitHub Actions + WIF is the working path.

### C. Argo CD / pull-based GitOps.

Considered. Reduces the need for a deploy workflow — Argo watches the cluster and reconciles to a Git-declared state. Rejected for now because (a) it adds a second control plane to operate, (b) image-tag bumps still need a mechanism (e.g. Argo Image Updater), and (c) we're a small team and a push-based workflow is easier to reason about. Revisit at 5+ environments or when multi-cluster lands.

### D. Auto-deploy prod on tag, no approval gate.

Rejected. One unreviewed merge that touches `values-prod.yaml` or bumps a load-bearing image should not reach production unreviewed. The approval gate is cheap friction for a large class of preventable outages.

### E. Run Tier 3 smoke on every PR against a preview environment.

Deferred. Preview environments per PR are the ideal but cost real GKE capacity per open PR. When the PR volume and the budget both support it, revisit — probably after prod launch.

---

## Implementation plan

### Phase 1 — Rename + fix Tier 1 (one PR)

- [ ] Rename `backend/__tests__/integration/` → `backend/__tests__/service/`. Update `backend/jest.config.js` only if the rename breaks discovery — current config (`testPathIgnorePatterns` excludes `utils/`, no `testMatch` override) auto-picks `*.test.js` under any path, so a directory rename alone should work. Run `npx jest --listTests` to confirm.
- [ ] `backend/__tests__/utils/testUtils.js`: `setupMongoDb()` and `setupPgDb()` branch on `process.env.INTEGRATION_TEST === 'true'` — when set, connect to `process.env.MONGO_URI` / `process.env.PG_*` via `mongoose.connect` and `new pg.Pool` respectively, and skip the in-memory server. The existing `__tests__/setup.js` already sets those envs when `INTEGRATION_TEST=true`; no new toggle needed. Keep `MongoMemoryServer` / `pg-mem` for the unset default so Tier 0 stays in-memory.
- [ ] Audit for likely breakage in the renamed suites. Specific patterns that silently depend on in-memory quirks:
  - Direct calls to `mongoServer.getUri()` / `pgPool` that the test bodies import from `testUtils` (real-service branch won't export `mongoServer`). Grep: `mongoServer\.|pgDb\.`.
  - `pg-mem` functions registered in `setupPgDb()` (e.g. `gen_random_uuid`). Real Postgres 16 has `gen_random_uuid` only with `pgcrypto` — add `CREATE EXTENSION IF NOT EXISTS pgcrypto` at start of real-services setup.
  - Tests that expect `collection.deleteMany({})` to be instant (real Mongo is slower; adjust timeouts if any fall under `jest.setTimeout(default)`).
  - `pg-mem` schema drift: the in-memory setup creates `pods`, `pod_members`, `messages` tables by hand — real PG gets its schema from `backend/config/init-pg-db.js`. Verify the two match; migrate the init-pg setup into the real-services branch.
- [ ] Update `backend/TESTING.md`: add a "Tier 0 / Tier 1" section matching the Decision table; deprecate the "integration" label and point at the new dir.
- [ ] `.github/workflows/tests.yml` already sets `INTEGRATION_TEST: "true"` and boots `mongo:7` + `postgres:16` — verify the new real-services branch actually fires in CI after the rename (add a one-line log assertion, e.g. `console.log('[tier1] using real services')` gated on the env, and grep the workflow log).

### Phase 1.5 — Chart-lint on every push (one small PR)

- [ ] New job `chart-lint` added to `.github/workflows/tests.yml` (single-workflow policy, not a separate file) running on every push. Command: `helm template k8s/helm/commonly -f k8s/helm/commonly/values.yaml -f k8s/helm/commonly/values-dev.yaml | kubeconform --strict --summary -output text`.
- [ ] CRD schemas: default `kubeconform` schemas cover core Kubernetes only. The chart uses ESO `ExternalSecret`, Ingress (GKE), and possibly cert-manager — supply these via `--schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' --schema-location default`. Pin to a specific `datreeio/CRDs-catalog` commit SHA to avoid drift.
- [ ] Optional second invocation against `-f values-prod.yaml` — gated on that file existing in-tree (it lands in Phase 5, not Phase 3). Use `if [ -f k8s/helm/commonly/values-prod.yaml ]; then ... fi` so Phase 1.5 merges independently of Phase 5.
- [ ] Add the `chart-lint` check to branch protection on `main`.

### Phase 2 — Gate Tier 2 on PRs (one small PR)

- [ ] `.github/workflows/smoke-test.yml`: add `on.pull_request.paths` filter. Paths to include: `k8s/**`, `backend/Dockerfile`, `frontend/Dockerfile`, `_external/clawdbot/**` (gateway source per CLAUDE.md §Build & Deploy), `dev.sh`, `.github/workflows/**`. Keep the existing `workflow_run` post-merge trigger.
- [ ] Add the smoke-test check to branch protection on `main` as **required only when status exists** (so PRs that don't touch the filtered paths — and thus don't run the check — aren't blocked by a missing status).
- [ ] **Human action:** repo admin adds `kind cluster smoke test` as an "optional" required check in the branch-protection rule (GitHub's "Require status checks to pass → expect checks from each PR" with no entries forces only-when-present semantics; alternately, use `required_status_checks.checks` with `app_id: null` in a custom ruleset — document whichever the admin picks).

### Phase 3 — WIF + dev deploy workflow (one PR + GCP setup)

> **Status:** Operational as of 2026-04-29. The `Deploy Dev` workflow has shipped multiple PRs to `commonly-dev` end-to-end (PR #250, #252, #253, #251, #254 in a single evening). WIF mints a fresh OIDC token per run, exchanges for a short-lived GCP access token, builds the four images in parallel, helm-upgrades the dev cluster. Trigger: `gh workflow run deploy-dev.yml --ref <branch> --repo Team-Commonly/commonly`. The "retire values-private.yaml" sub-task below is still outstanding (operator-local file is materialized inside the workflow from a GitHub Actions secret today, but not yet decomposed into ESO-managed entries).
>
> **Operational gotcha (memory: `feedback-deploy-dev-builds-only-main`)**: the workflow rebuilds **all four images** from the dispatched ref. Dispatching `--ref main` while a feature branch isn't merged yet strips that work from the live frontend/backend image. This bit us once on the v2 mount on 2026-04-29 (recovery via `kubectl rollout undo deploy/frontend --to-revision=N`). Sequence the merge before the dispatch.

- [ ] **GCP setup** (follow `docs/deployment/GITHUB_DEPLOY_SETUP.md` in full): WIF pool + GitHub provider with `assertion.repository=='Team-Commonly/commonly'` condition; `deploy-github` SA with `roles/artifactregistry.writer` on the `docker` repo, `roles/container.clusterViewer` at project level; Kubernetes `ClusterRoleBinding` of `edit` against the SA's identity on `commonly-dev` only.
- [ ] **Secrets in GitHub:** `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`. **Environment:** create `dev` with no approvers.
- [ ] **Submodule:** `actions/checkout@v4` with `submodules: recursive` — the gateway image is built from `_external/clawdbot/`, a git submodule. Without this the gateway build step fails immediately.
- [ ] **Build step** (three images, one tag each, all set to the current commit SHA for simplicity and rollback symmetry):
  ```bash
  export IMG_TAG=${GITHUB_SHA::8}
  # REG is computed at workflow runtime from the DEV_GCP_PROJECT_ID secret —
  # never committed inline (see feedback-no-infra-leak-in-public-repo memory).
  export REG="${AR_REGISTRY_HOST}/${PROJECT_ID}/${AR_REPO}"
  docker build backend  -t $REG/commonly-backend:$IMG_TAG  && docker push $REG/commonly-backend:$IMG_TAG
  docker build frontend --build-arg REACT_APP_API_URL=https://api-dev.commonly.me -t $REG/commonly-frontend:$IMG_TAG && docker push $REG/commonly-frontend:$IMG_TAG
  cd _external/clawdbot && docker build --build-arg OPENCLAW_EXTENSIONS=acpx --build-arg OPENCLAW_INSTALL_GH_CLI=1 -t $REG/clawdbot-gateway:$IMG_TAG . && docker push $REG/clawdbot-gateway:$IMG_TAG
  ```
- [ ] **Helm upgrade step** — the chart has three separate image keys at `backend.image.tag`, `frontend.image.tag`, `agents.clawdbot.image.tag` (verified against `values.yaml` line 22, 75, 182). Set all three in one command:
  ```bash
  helm upgrade commonly-dev k8s/helm/commonly -n commonly-dev \
    -f k8s/helm/commonly/values.yaml \
    -f k8s/helm/commonly/values-dev.yaml \
    --set backend.image.tag=$IMG_TAG \
    --set frontend.image.tag=$IMG_TAG \
    --set agents.clawdbot.image.tag=$IMG_TAG
  ```
  Note the removed third `-f values-private.yaml` — covered by the next bullet.
- [ ] **Retire `values-private.yaml`** (this is the load-bearing migration; no agent can do it without a human pulling the actual file from the operator's laptop):
  - **Human action**: open `.dev/values-private.yaml` (operator-local, gitignored) and categorize each key as (a) non-secret config → `values-dev.yaml` commit, (b) secret → GCP Secret Manager entry + `ExternalSecret` manifest under `k8s/helm/commonly/templates/`.
  - Non-secret keys expected (per CLAUDE.md §Kubernetes): `global.gcpProjectId`, `postgresql.host`, `*.image.repository` overrides. These go into `values-dev.yaml`; `values.yaml`'s `YOUR_GCP_PROJECT_ID` placeholders stay as the OSS-safe default.
  - Any key named like a credential (`*_password`, `*_token`, `*_key`, `jwtSecret`, `*_connectionString`) → Secret Manager. The existing `api-keys` ESO pattern (CLAUDE.md §Agent Runtime) is the template.
  - Update `docs/deployment/KUBERNETES.md` and `CLAUDE.md` §Kubernetes to remove the three-`-f` instruction and reference the new two-file shape.
- [ ] **Status reporting:** the workflow posts **both** a GitHub status check (`deploy-dev / build-and-deploy`) and a PR/commit comment with the deploy outcome (tag, Helm revision, probe results). Agents observe via `mcp__github__pull_request_read` → `get_check_runs` or `get_comments`.

### Phase 4 — Tier 3 smoke + rollback (one PR)

- [ ] `deploy-dev.yml` adds post-deploy HTTP probes against `api-dev.commonly.me` — **unauthenticated only this phase**: `GET /api/health/live` and `GET /api/health/ready`. Covers pod-came-up and DB-reachability. Auth round-trip probes deferred until a smoke credential story lands (dedicated account + ESO-rotated secret + workflow retrieval).
- [ ] **Rollback target** — match the Decision's "last-known-good revision" design:
  - On a passing deploy, the workflow stamps `commonly.me/last-good-revision: <helm-revision-number>` as an annotation on the Helm release (via `kubectl annotate deployment/backend` on the namespace, or on the Helm-managed `Secret` carrying release state).
  - On a probe failure, the workflow reads that annotation and runs `helm rollback commonly-dev <last-good-revision>`. **Not** `helm rollback commonly-dev 0`.
  - Edge case — first-ever deploy: if `helm history commonly-dev -o json | jq 'length'` is `1` (no prior revision), **skip auto-rollback**. Workflow fails loudly, leaves the broken release in place, and pages via the same GitHub-issue mechanism below. Rationale: there's nothing known-good to roll back to.
- [ ] **Consecutive-failure escalation** — keyed on the last-good pointer, not the commit SHA:
  - If three deploys in a row roll back and the pointer doesn't advance, the workflow (a) fails the `deploy-dev` status check hard, (b) opens a GitHub issue via `gh issue create` labeled `deploy-stuck` with the three failed SHAs, (c) stops auto-rolling-back until the issue is closed (workflow checks for open issues with that label at start).

### Phase 5 — Prod path (one PR + GCP setup)

- [ ] Mirror phases 3–4 for `commonly-prod` with the `prod` environment gated by one reviewer.
- [ ] Trigger on tag push `v*.*.*` only.
- [ ] Document release procedure in `docs/deployment/RELEASE.md`.

### Phase 6 — Preview environments (deferred)

- [ ] Per-PR preview namespace in `commonly-dev` cluster, auto-torn-down on PR close.
- [ ] Revisit only after prod is live and PR volume justifies.

---

## Open questions

- **Tier 1 cost at scale.** Service-container startup adds ~20s to each CI run. If the Tier 1 suite grows beyond the budget we accept, do we shard it across jobs or start excluding routes? Track Tier 1 wall time; revisit at > 5 min. *Not blocking any phase; monitor once Phase 1 lands.*
- **Migration risk for `values-private.yaml`.** The file encodes keys we haven't enumerated in the repo. Audit during the Phase 3 migration (which is human-driven — see Phase 3's "Retire values-private.yaml" checklist). Anything not clearly non-secret goes to Secret Manager by default.

*Previously-listed questions resolved during review:*
- *Cloud-agent status output* → both a GitHub check-run and a PR comment (Phase 3 checklist).
- *Tier 2 blocking-vs-warning* → blocks merge, but only when the check ran (path-filtered); see Phase 2 human-action bullet.
- *`backend/TESTING.md` / `frontend/TESTING.md`* → updated in Phase 1 (now a checklist item).

---

## Decision log

- 2026-04-19: Draft created. Motivated by the ADR-002 Phase 1b-a PR review surfacing two gaps: (1) unit tests couldn't catch ACL false-denies or profile-picture URL shape mismatches because they mocked Mongoose queries, and (2) the Claude cloud agent that authored the PR had no path to observe a real-cluster deployment. Both gaps are structural to CI/CD, not to ADR-002.
