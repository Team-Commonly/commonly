# Dev Environment and Deploy Notes — full text

Moved verbatim from `CLAUDE.md` ("Current State", the ADR-010 / ADR-015 index
entries, "Kubernetes", "Build & Deploy") as part of the CLAUDE.md slim-down
(TASK-528). `CLAUDE.md` keeps the commands and rules in short form and points
here. No rule was reworded or dropped. The build-arg history lives in
[`build-arg-history.md`](build-arg-history.md).

## Current state

- **Repository**: Team-Commonly/commonly, branch: `main`
- **Live**: `commonly.me` (frontend) / `api.commonly.me` (API) — since the 2026-06-26 domain flip. **The old `app-dev.commonly.me` / `api-dev.commonly.me` hostnames are DEAD** (dangling DNS/tunnel entries, bare nginx 404 — verified 2026-07-03); anything still pointing at them (laptop CLI `--instance dev` profiles, old wrapper-agent configs) is polling a corpse. Same single cluster (`commonly-dev` namespace) serves the apex.
- **Live image tags**: `kubectl get deploy -n commonly-dev -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image` (the file `values-dev.yaml` lags reality between deploys — trust the cluster, not the chart).
- **GKE context, project ID, image registry, ops account**: not committed (operator-private, see `feedback-no-infra-leak-in-public-repo` memory + `.dev/values-private.yaml` / `.dev/ops-credentials.md` locally). Anything that needs a project-scoped identifier is supplied at deploy time via GitHub Actions secrets (`DEV_GCP_PROJECT_ID`, `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`) or via ExternalSecrets.
- **UI verification**: Use MCP Playwright (`mcp__playwright__*`)

## Key-doc index entries (full text)

- **ADR-010 Commonly MCP Server**: `/docs/adr/ADR-010-commonly-mcp-server.md` — `@commonlyai/mcp` server exposing CAP as standard MCP tools; the thing ADR-008's `mcp[]` declarations point at; deprecation path for the openclaw extension's `commonly_*` block. **Phase 1 shipped; Phase 2+ paused under ADR-011. Memory tools added 2026-05-10 (ADR-012 Phase 4); reactions + PR review + pod-file read/attach + a2a-DM fix added through 2026-07-05 — 22 tools total (`@commonlyai/mcp@0.1.7`).** See [`docs/MCP_INTEGRATION.md`](../MCP_INTEGRATION.md) for the operator walkthrough.
- **ADR-015 Spot pool for stateless workloads**: `/docs/adr/ADR-015-spot-pool-for-stateless-workloads.md` — `backend` + `frontend` + `redis` schedule on `spot-pool` (taint `workload-tier=spot:NoSchedule`), agent runtimes (`clawdbot-gateway`, `cloud-codex-*`, `litellm`) stay on `dev-pool` (taint `pool=dev:NoSchedule`). Cuts ~$45-70/mo. Spot VMs can be reclaimed with 30s notice — anything holding session state must stay off them.

## Kubernetes (GKE — commonly-dev)

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

## Build & Deploy

**Primary path: GitHub Actions `Deploy Dev` workflow** (`.github/workflows/deploy-dev.yml`, ADR-009 Phase 3).

```bash
gh workflow run deploy-dev.yml --ref main -f ref=<full 40-char SHA> --repo Team-Commonly/commonly
gh run list --workflow=deploy-dev.yml -L 1 --repo Team-Commonly/commonly   # most-recent run
```

`--ref main` selects the workflow file's revision; the `ref` input selects the commit to build, as a full SHA, and defaults to main HEAD when omitted. That commit needs a green staging-smoke. Builds backend + frontend + clawdbot-gateway + commonly-bot in parallel from that commit, pushes to AR, helm-upgrades the dev cluster (~8–12 min). All four images get the same tag (short SHA of `HEAD`). **Whatever commit the `ref` input names (main HEAD by default) is what ends up live** — see `feedback-deploy-dev-builds-only-main` memory; if a feature branch isn't merged yet, dispatching from `main` will strip it from the deployed images.

**Escape hatch — local docker build** (only when CI is broken or for a hotfix the user explicitly wants by hand):

```bash
TAG=$(date +%Y%m%d%H%M%S)
REG=<AR_REGISTRY_HOST>/<DEV_GCP_PROJECT_ID>/docker     # locally-resolved, never committed
docker build backend  -t "$REG/commonly-backend:$TAG"  && docker push "$REG/commonly-backend:$TAG"
docker build frontend --build-arg REACT_APP_API_URL=https://api.commonly.me \
  -t "$REG/commonly-frontend:$TAG" && docker push "$REG/commonly-frontend:$TAG"
(cd _external/clawdbot && docker build \
  --build-arg OPENCLAW_EXTENSIONS=acpx \
  --build-arg OPENCLAW_INSTALL_GH_CLI=1 \
  --build-arg OPENCLAW_INSTALL_DOC_TOOLCHAIN=1 \
  -t "$REG/clawdbot-gateway:$TAG" . && docker push "$REG/clawdbot-gateway:$TAG")
```


Note also that the gateway image is where the openclaw *extension code* lives —
`commonly_*` tools included. A submodule bump alone changes nothing live, and
`reprovision-all` only regenerates `moltbot.json` from the DB. A pin change
reaches agents as: **merge → `Deploy Dev` (rebuilds from the new gitlink) →
`reprovision-all`.**

`gcloud builds submit` is blocked by the dev project's org policy on AR uploads, so don't reach for it.
