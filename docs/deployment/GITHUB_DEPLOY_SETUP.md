# GitHub Actions → GKE deploy setup

Companion to [`ADR-009`](../adr/ADR-009-test-tiers-and-ci-cd-to-gke.md).
ADR-009 commits to **Workload Identity Federation only** — no long-lived
service account keys in GitHub. This runbook is the concrete gcloud sequence.

Run the blocks below once from an account with `roles/owner` (or
`roles/iam.workloadIdentityPoolAdmin` + `roles/iam.serviceAccountAdmin` +
`roles/resourcemanager.projectIamAdmin`) on the dev GCP project. Expect
~15 minutes end-to-end.

---

## Prep

```bash
# Operator-local: set to the dev GCP project ID (not committed; supplied
# at workflow runtime via the DEV_GCP_PROJECT_ID GitHub Actions secret).
export PROJECT_ID="$(gcloud config get-value project)"
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
export REPO=Team-Commonly/commonly

gcloud config set project $PROJECT_ID

# Enable APIs the deploy workflow needs.
gcloud services enable \
  iamcredentials.googleapis.com \
  iam.googleapis.com \
  artifactregistry.googleapis.com \
  container.googleapis.com \
  sts.googleapis.com
```

Sanity check:

```bash
gcloud container clusters list --filter="name~commonly"   # should show commonly-dev
gcloud artifacts repositories list --location=us-central1 # should show 'docker'
```

---

## Setup

Short-lived tokens minted per workflow run; no JSON key ever leaves GCP.

### 1. Create the deploy service account

```bash
export DEPLOY_SA=deploy-github
export DEPLOY_SA_EMAIL=$DEPLOY_SA@$PROJECT_ID.iam.gserviceaccount.com

gcloud iam service-accounts create $DEPLOY_SA \
  --display-name="GitHub Actions deploy (WIF)" \
  --description="Used by .github/workflows/deploy-*.yml via WIF"
```

### 2. Grant the SA only what it needs

```bash
# Push images to the 'docker' AR repo (scoped, not project-wide admin).
gcloud artifacts repositories add-iam-policy-binding docker \
  --location=us-central1 \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/artifactregistry.writer

# Authenticate to ANY cluster in the project (read-only). Least-privilege
# IAM bootstrap so gcloud can fetch kubeconfig; the real deploy permissions
# come from the Kubernetes RBAC binding below.
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/container.clusterViewer
```

Then grant deploy permissions at the **Kubernetes layer**, scoped to
`commonly-dev` only. This is the reviewer-preferred alternative to
IAM-conditioned `roles/container.developer`: IAM conditions only evaluate
against cluster-shaped resources, which can silently deny mid-deploy when
Helm touches operation / node-pool / workload resources with different
resource paths. Kubernetes RBAC scopes cleanly to one cluster and covers
every resource type Helm needs.

```bash
gcloud container clusters get-credentials commonly-dev --region=us-central1

# The SA's K8s identity follows a fixed naming pattern; RoleBinding binds
# the existing cluster-admin or deploy-oriented ClusterRole to it.
cat <<EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: deploy-github
subjects:
  - kind: User
    name: $DEPLOY_SA_EMAIL
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  # `admin` is required when the chart manages RBAC resources
  # (Role/RoleBinding/ServiceAccount). `edit` omits rbac.authorization.k8s.io
  # verbs and causes `helm upgrade` to fail with "roles.rbac.authorization.k8s.io
  # ... is forbidden" once the chart renders a Role. `admin` is still
  # namespace-scoped by the binding's target cluster — this is narrower than
  # the project-wide IAM role `roles/container.developer`, and narrower than
  # cluster-admin. Tighten further with a custom ClusterRole only if helm's
  # set of verbs is well-understood.
  name: admin
  apiGroup: rbac.authorization.k8s.io
EOF
```

Repeat the `kubectl apply` against `commonly-prod` when that cluster is
added — each cluster gets its own binding, and revoking access to one
cluster is a single `kubectl delete clusterrolebinding deploy-github`.

### 3. Create the WIF pool + GitHub provider

```bash
export POOL=github
export PROVIDER=github-provider

gcloud iam workload-identity-pools create $POOL \
  --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc $PROVIDER \
  --location=global \
  --workload-identity-pool=$POOL \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository=='$REPO'"
```

The `attribute-condition` is the critical line — it blocks tokens minted by
forks or other repos from ever exchanging for a GCP token, regardless of the
binding below.

### 4. Bind the SA to the pool

Scope the binding to the branches/environments that should deploy. Two
bindings: one for merge-to-main → dev, one for the prod environment.

```bash
export POOL_NAME=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL

# Dev: only refs/heads/main
gcloud iam service-accounts add-iam-policy-binding $DEPLOY_SA_EMAIL \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL_NAME/attribute.ref/refs/heads/main"

# Prod: only the 'prod' GitHub environment (gated by reviewer in GitHub).
gcloud iam service-accounts add-iam-policy-binding $DEPLOY_SA_EMAIL \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/$POOL_NAME/attribute.environment/prod"
```

### 5. Capture the two values for GitHub

```bash
echo "WIF_PROVIDER=$POOL_NAME/providers/$PROVIDER"
echo "WIF_SERVICE_ACCOUNT=$DEPLOY_SA_EMAIL"
```

### 6. Configure GitHub

Repo **Settings → Secrets and variables → Actions → Repository secrets**:

```
WIF_PROVIDER          <value from above>
WIF_SERVICE_ACCOUNT   deploy-github@<PROJECT_ID>.iam.gserviceaccount.com
DEV_GCP_PROJECT_ID    <PROJECT_ID>          # the workflow reads this and never logs it
```

Repo **Settings → Environments**:

- Create `dev` — no approvers. Deploy-on-merge fires automatically.
- Create `prod` — add **Required reviewers** (at least one), restrict to tags
  matching `v*.*.*` under **Deployment branches and tags**.

### 7. Workflow usage

```yaml
# .github/workflows/deploy-dev.yml (excerpt)
permissions:
  id-token: write   # required to mint the OIDC token
  contents: read

jobs:
  deploy:
    environment: dev
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker us-central1-docker.pkg.dev --quiet

      # docker build + push, helm upgrade, smoke probes — per ADR-009 Phase 3/4.
```

### 8. Verify

```bash
# From a workflow run log, confirm:
#   google-github-actions/auth  succeeded
#   `gcloud auth list` shows the deploy SA as active
#   `gcloud container clusters get-credentials commonly-dev` succeeds
```

---

## Revocation

### Revoke deploy access entirely

```bash
# Strip the K8s binding first — one cluster at a time, fastest cut-off.
kubectl delete clusterrolebinding deploy-github

# Then strip IAM so the SA can't even authenticate to other clusters.
gcloud projects remove-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/container.clusterViewer

gcloud artifacts repositories remove-iam-policy-binding docker \
  --location=us-central1 \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/artifactregistry.writer
```

### Delete the SA (nuclear)

```bash
gcloud iam service-accounts delete $DEPLOY_SA_EMAIL
```

---

## Troubleshooting

**`google-github-actions/auth` fails with `Permission 'iam.serviceAccounts.getAccessToken' denied`.**
The SA binding to the pool is wrong. Re-run step 4 and check that
`attribute.ref` / `attribute.environment` match the workflow's context.

**Auth succeeds but `docker push` returns 403.**
Missing `roles/artifactregistry.writer` on the `docker` repo. Re-run step 2.

**`helm upgrade` fails with `Unauthorized` or `forbidden`.**
The Kubernetes RBAC binding is missing on this cluster. Re-run the
`kubectl apply` block from step 2 against the target cluster. If auth
itself is the issue, confirm the SA has `roles/container.clusterViewer`
at project level so `gcloud container clusters get-credentials` can
fetch kubeconfig.

**`helm upgrade` returns `Forbidden: cannot get/create resource "roles"` or `cannot create namespaces`.**
The `edit` ClusterRole doesn't grant `rbac.authorization.k8s.io` verbs
or namespace creation. The default here is `admin` (see step 2). If a
cluster still has a legacy `edit` binding, recreate it:
```bash
kubectl delete clusterrolebinding deploy-github
# then re-apply the block from step 2 with name: admin
```
Note: `roleRef` is immutable — `kubectl patch` returns
"cannot change roleRef", delete+re-apply is the only path.

**PR from a fork triggers the workflow and `auth` succeeds.**
`attribute-condition` on the provider was missed (step 3). The
condition must include `assertion.repository=='Team-Commonly/commonly'` —
verify with `gcloud iam workload-identity-pools providers describe`.
