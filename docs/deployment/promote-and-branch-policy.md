# Prod promotion (`promote_sha`) and the `dev` environment branch policy

## Promotion model

From Sunday on, prod changes land by **promoting a staging-verified SHA**, not by
building on the prod deploy:

1. A merge to `main` runs `deploy-staging.yml`: it builds `commonly-backend`,
   `commonly-bot`, and two frontend variants — `frontend:<sha8>` (prod variant,
   `api.commonly.me`) and `frontend:<sha8>-staging` (`api-staging.commonly.me`) —
   deploys `commonly-staging`, smokes it, and records a **`staging-smoke`** commit
   status on that SHA.
2. To ship that SHA to prod, dispatch `Deploy Dev` with **`promote_sha=<full sha>`**.
   The promote path does **no docker build**: it retags the prebuilt prod images at
   `<sha8>`. Its gate refuses unless:
   - the tag has no `-staging` suffix (the frontend being promoted is the prod variant), and
   - the SHA carries `staging-smoke=success`, and
   - `commonly-{backend,frontend,bot}:<sha8>` already exist in Artifact Registry.
3. `dry_run=true` runs the resolution + gate checks and prints the plan with no
   build and no deploy (target ≤4 min) — use it to confirm a SHA is promotable.

The normal build path (no `promote_sha`) is unchanged and remains the escape hatch.

## The `dev` environment deployment-branch policy — SET THIS AT MERGE (Friday), not before

Today the `dev` GitHub environment has **no deployment-branch restriction**, so
`Deploy Dev` can be dispatched from *any* ref and ship it to prod. Once cut
branches (`deploy/*`) and the promote path are the deploy routes, restrict the
environment so only reviewed refs reach prod:

- Settings → Environments → **dev** → Deployment branches → **Selected branches**:
  - `main`
  - `deploy/*`

This is a **repo-settings change, applied by hand at merge on Friday** (after the
Fri 12:00 cut), not by this PR and not by any workflow. It is recorded here so the
change is reviewable and not forgotten. Rollback: set Deployment branches back to
"All branches".

> Scope note: the policy restricts which refs may deploy the `dev` environment
> (which serves prod at the apex since the 2026-06-26 flip). It does not touch
> branch protection on `main`.
