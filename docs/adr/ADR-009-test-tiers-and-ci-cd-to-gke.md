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
| 2 | **Cluster smoke** | Full Helm install on kind; pods come up, health probes pass, HTTP smoke against ingress | PRs touching `k8s/`, `Dockerfile`, `dev.sh cluster`; `workflow_dispatch` | required on eligible paths |
| 3 | **Dev-env smoke** | Real GKE `commonly-dev` after deploy-on-merge; HTTP probes against `api-dev.commonly.me`; auto-rollback on failure | merge to `main` | informational (rolls back on fail) |

**Tier 1 is the rename most of the audit turns on.** The current "integration" suite becomes Tier 1 *and* actually uses the service containers, not `MongoMemoryServer`. `setupMongoDb()` gets a `useRealServices` branch that `mongoose.connect(process.env.MONGO_URI)` when `INTEGRATION_TEST=true`, and leaves the memory server for Tier 0. `pg-mem` similarly falls back to a real `pg.Pool` against the `postgres:16` container when the env says so. Nothing else in the test body changes — same fixtures, same assertions.

**Tier 2 is clarified, not new.** `smoke-test.yml` already spins up kind and runs `./dev.sh cluster test`. We change the trigger so it runs on PRs that touch deployment surfaces (path-filtered `on.pull_request.paths`) and keep the post-merge run. Every PR that *could* break a deploy gets cluster signal before merge.

**Tier 3 is new and depends on the deploy path below.**

### CI/CD to GKE

**Auth: Workload Identity Federation only.** No service account JSON keys in GitHub secrets. One WIF pool in the `commonly-493005` GCP project federates trust to the `Team-Commonly/commonly` repo; GitHub Actions exchanges its OIDC token for a short-lived GCP access token via `google-github-actions/auth@v2`. Keys never leave GCP.

**Triggers:**
- **Dev**: merge to `main` → build images → push to `us-central1-docker.pkg.dev/...` → `helm upgrade commonly-dev` → Tier 3 smoke against `api-dev.commonly.me` → `helm rollback` on smoke failure.
- **Prod**: tag push `v*.*.*` → identical pipeline against `commonly-prod`, gated by a GitHub environment with one-reviewer approval. No automatic prod deploys.

**Values handling — the `values-private.yaml` problem.**

Current state: `values-private.yaml` lives only on Lily's laptop at `/home/xcjam/workspace/commonly/.dev/values-private.yaml`. It holds the real GCP project ID, PG host, and image repo overrides. Anyone else running `helm upgrade` either doesn't have it (deploy fails) or recreates it from memory (drift).

Target state: the *secret* content in `values-private.yaml` moves to GCP Secret Manager and is pulled into the cluster by ESO (which already owns `api-keys` per CLAUDE.md §Agent Runtime). The *config* content (GCP project ID, PG host, image repo) moves into a committed `values-dev.yaml` / `values-prod.yaml` — these are not secrets and hiding them just makes the repo unusable to new contributors. One uncommitted file disappears; three committed files + ESO handle what it used to.

**Image tags.** Workflow sets image tag to `${sha}` (short SHA) and passes it via `--set image.tag=...` on helm upgrade, not by editing `values-dev.yaml`. That keeps the workflow git-clean (no auto-commit back to main), keeps `values-dev.yaml` reviewable, and makes rollback a matter of `helm upgrade --set image.tag=<previous-sha>` rather than a values-file revert.

**Rollback.** Tier 3 smoke is the gate. On failure, workflow runs `helm rollback commonly-dev 0` (last revision) and posts the failed probe output to the PR or commit. Human decides whether to fix forward or investigate.

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
- **Helm upgrade scope.** Deploy SA has `roles/container.developer` on the `commonly-dev` / `commonly-prod` clusters only. No ability to create new clusters or modify node pools.
- **No secrets echoed in logs.** `set -x` banned in the deploy workflow; `::add-mask::` used for any intermediate token output.
- **Tier 3 smoke uses a dedicated test account.** Smoke probes don't use real user credentials — a `smoke@commonly.me` service account gets minimal read access and is rotated via ESO.

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

- [ ] Rename `__tests__/integration/` → `__tests__/service/` and update jest projects.
- [ ] `setupMongoDb()` / `setupPgDb()` read `INTEGRATION_TEST=true` and connect to `MONGO_URI` / `PG_*` env instead of in-memory, when set.
- [ ] Verify all existing "integration" tests still pass against the CI service containers. Fix the ones that silently relied on `MongoMemoryServer` quirks (expect a few).
- [ ] Update `backend/TESTING.md` with the new tier names.

### Phase 2 — Gate Tier 2 on PRs (one small PR)

- [ ] `smoke-test.yml`: add `on.pull_request.paths` filter for `k8s/**`, `backend/Dockerfile`, `frontend/Dockerfile`, `dev.sh`, `.github/workflows/**`. Keep post-merge trigger.
- [ ] Surface the kind smoke as a required check on PRs with a matching path.

### Phase 3 — WIF + dev deploy workflow (one PR + GCP setup)

- [ ] GCP: create WIF pool + provider in `commonly-493005`; grant `artifactregistry.writer` and `container.developer` to the deploy SA scoped to dev.
- [ ] GitHub: configure `dev` environment with no approvals (auto-deploy).
- [ ] `.github/workflows/deploy-dev.yml`: build backend + frontend + gateway images, push to AR, `helm upgrade commonly-dev --set image.tag=${sha}`, post status.
- [ ] Retire `values-private.yaml` for dev: migrate its content to committed `values-dev.yaml` (non-secret config) and ESO (secrets).
- [ ] Remove the `/home/xcjam/workspace/commonly/.dev/values-private.yaml` reference from CLAUDE.md; document the new shape.

### Phase 4 — Tier 3 smoke + rollback (one PR)

- [ ] `deploy-dev.yml` adds post-deploy HTTP probes against `api-dev.commonly.me` (health, auth round-trip, one representative domain endpoint).
- [ ] `helm rollback commonly-dev 0` on probe failure.
- [ ] Three-consecutive-rollbacks → hard CI failure + GitHub issue auto-opened.

### Phase 5 — Prod path (one PR + GCP setup)

- [ ] Mirror phases 3–4 for `commonly-prod` with the `prod` environment gated by one reviewer.
- [ ] Trigger on tag push `v*.*.*` only.
- [ ] Document release procedure in `docs/deployment/RELEASE.md`.

### Phase 6 — Preview environments (deferred)

- [ ] Per-PR preview namespace in `commonly-dev` cluster, auto-torn-down on PR close.
- [ ] Revisit only after prod is live and PR volume justifies.

---

## Open questions

- **Tier 1 cost at scale.** Service-container startup adds ~20s to each CI run. If the Tier 1 suite grows beyond the budget we accept, do we shard it across jobs or start excluding routes? Track Tier 1 wall time; revisit at > 5 min.
- **Where does cloud-agent status appear?** PR comment? Commit status? Both? A status check is the normal place; a PR comment is friendlier for the agent to observe via `mcp__github__pull_request_read`. Start with both and drop one if it's noise.
- **Migration risk for `values-private.yaml`.** The file encodes some decisions (PG host choice, custom image repo) that may not be safe to put in a public file. Audit before migration; anything truly sensitive stays in Secret Manager.
- **Should Tier 2 block merge or just warn?** If cluster smoke takes 20 min and PRs touch `k8s/` rarely, blocking is fine. If it becomes frequent, consider warning-only with a label (`cluster-smoke-required`) that promotes it to blocking when needed.
- **What about `backend/TESTING.md` / `frontend/TESTING.md`?** These reference the current naming. They get updated in Phase 1. Track so they don't drift.

---

## Decision log

- 2026-04-19: Draft created. Motivated by the ADR-002 Phase 1b-a PR review surfacing two gaps: (1) unit tests couldn't catch ACL false-denies or profile-picture URL shape mismatches because they mocked Mongoose queries, and (2) the Claude cloud agent that authored the PR had no path to observe a real-cluster deployment. Both gaps are structural to CI/CD, not to ADR-002.
