# GitHub Actions → GKE deploy setup

Companion to [`ADR-009`](../adr/ADR-009-test-tiers-and-ci-cd-to-gke.md). Two
paths: **Workload Identity Federation** (recommended, no long-lived credential
in GitHub) and **Service Account JSON key** (fast path, one secret in GitHub,
rotatable-forever).

Pick one. Run the gcloud blocks once from an account with `roles/owner` (or
`roles/iam.workloadIdentityPoolAdmin` + `roles/iam.serviceAccountAdmin` +
`roles/resourcemanager.projectIamAdmin`) on `commonly-493005`.

---

## Prep (both paths)

```bash
# Replace if your project differs.
export PROJECT_ID=commonly-493005
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

## Path A — Workload Identity Federation (recommended)

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

# Talk to the dev cluster. Repeat for prod when you add it.
gcloud container clusters get-credentials commonly-dev --region=us-central1
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/container.developer \
  --condition="expression=resource.name.endsWith('/clusters/commonly-dev'),title=commonly-dev-only"
```

> **Note:** `roles/container.developer` at project level with a condition is
> simpler than cluster-level RBAC and fine for a two-cluster setup. Tighten to
> cluster RBAC if you add a third environment.

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
WIF_SERVICE_ACCOUNT   deploy-github@commonly-493005.iam.gserviceaccount.com
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

## Path B — Service Account JSON key (fast path)

One secret in GitHub, long-lived credential that you rotate manually. Use if
you need to deploy *today* and can't wait for the WIF setup to land.

### 1–2. SA + roles

Same as Path A steps 1 and 2. Skip WIF pool/provider/binding (steps 3–4).

### 3. Create a key

```bash
gcloud iam service-accounts keys create /tmp/deploy-github-key.json \
  --iam-account=$DEPLOY_SA_EMAIL

# Base64 so GitHub accepts it as a single-line secret.
base64 -w0 /tmp/deploy-github-key.json > /tmp/deploy-github-key.b64
cat /tmp/deploy-github-key.b64
```

### 4. GitHub secret

**Settings → Secrets and variables → Actions**:

```
GCP_SA_KEY   <paste the base64 blob>
```

### 5. Workflow usage

```yaml
# .github/workflows/deploy-dev.yml (excerpt)
permissions:
  contents: read   # no id-token needed

jobs:
  deploy:
    environment: dev
    steps:
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}
```

### 6. Clean up the local file

```bash
shred -u /tmp/deploy-github-key.json /tmp/deploy-github-key.b64
```

### 7. Rotation

```bash
# List active keys
gcloud iam service-accounts keys list --iam-account=$DEPLOY_SA_EMAIL

# Revoke an old key by ID (after confirming the new one works)
gcloud iam service-accounts keys delete <KEY_ID> --iam-account=$DEPLOY_SA_EMAIL
```

Do this at least every 90 days. Set a calendar reminder — there is no
automatic expiry.

---

## Migration: Path B → Path A

If you start with the JSON key and want to move to WIF later:

1. Run Path A steps 3–6 (WIF pool, provider, binding, secrets).
2. Update workflows to the Path A auth step.
3. Verify one green deploy on the new path.
4. Delete the SA key via step 7 of Path B.
5. Delete the `GCP_SA_KEY` GitHub secret.

No disruption if the workflow is updated in the same PR as the WIF binding.

---

## Revocation (both paths)

### Revoke deploy access entirely

```bash
# Strips all IAM bindings on the SA. Deploys fail immediately.
gcloud projects remove-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/container.developer

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
The SA binding to the pool is wrong. Re-run Path A step 4 and check that
`attribute.ref` / `attribute.environment` match the workflow's context.

**Auth succeeds but `docker push` returns 403.**
Missing `roles/artifactregistry.writer` on the `docker` repo. Re-run Path A
step 2.

**`helm upgrade` fails with `Unauthorized`.**
Missing `roles/container.developer` OR the SA is valid but `kubectl` is using
an old kubeconfig. Run `gcloud container clusters get-credentials` in the
workflow before `helm`.

**PR from a fork triggers the workflow and `auth` succeeds.**
`attribute-condition` on the provider was missed (Path A step 3). The
condition must include `assertion.repository=='Team-Commonly/commonly'` —
verify with `gcloud iam workload-identity-pools providers describe`.
