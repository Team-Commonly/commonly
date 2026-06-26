# Domain migration → commonly.me

Move the dev cluster's public surface from `app-dev` / `api-dev` to the apex
`commonly.me` (frontend) + `api.commonly.me` (backend) + `litellm.commonly.me`
(model gateway), **replacing** the old hosts.

> **Branch:** `domain-commonly-me` holds the code/config side. It is **not
> deployed**. Deploying it flips the dev ingress to the new hosts, so it must
> only ship **after** DNS for the new hosts is live (step 1), or the app goes
> dark. Do the steps in order.

## Host mapping

| Was | Now |
|---|---|
| `app-dev.commonly.me` | `commonly.me` (apex) |
| `api-dev.commonly.me` | `api.commonly.me` |
| `litellm-dev.commonly.me` | `litellm.commonly.me` |

## What the branch already changes (code/config)

- `k8s/helm/commonly/values.yaml` + `values-dev.yaml` — `backend.env.frontendUrl`,
  `backendUrl`, ingress `hosts.{frontend,backend,litellm}.host`, and
  `cloudflared.hostnames` (also deduped a repeated `api-dev` entry and dropped a
  stray `app.commonly.me`).
- `.github/workflows/deploy-dev.yml` + `cloudbuild.frontend.yaml` —
  `REACT_APP_API_URL=https://api.commonly.me` (frontend build arg).
- `backend/server.ts` — CORS fallback default + a doc comment.
- `frontend/src/v2/components/V2AgentBYO.tsx` — BYO snippet API-URL fallback.
  (The hostname-derivation regex correctly falls through to this fallback for
  the apex `commonly.me`, which has no `app` prefix to swap.)

## Operator steps (in order) — only you can do 1, 3, 4

### 1. DNS + Cloudflare tunnel (BEFORE deploying the branch)
- Point `commonly.me` (apex — use CNAME-flattening / Cloudflare proxied),
  `api.commonly.me`, and `litellm.commonly.me` at the **same cloudflared tunnel**
  the old hosts use.
- In the tunnel's public-hostname config, add the three new hostnames routed to
  the ingress controller service (same target as the old hosts today).
- Verify each resolves and the tunnel accepts it (a 404/redirect from the
  ingress is fine at this stage — it proves the tunnel + ingress are reachable).

### 2. Merge + deploy the branch
- Merge `domain-commonly-me` to `main` (squash, then `git push origin <branch>:main`).
- `gh workflow run deploy-dev.yml --ref main` — rebuilds the frontend with
  `REACT_APP_API_URL=https://api.commonly.me` and helm-upgrades the dev cluster
  so the ingress now serves the new hosts. **At this point the old hosts stop
  being served** (clean replacement).

### 3. OAuth callback URLs (after deploy, before announcing)
- **Discord** developer portal → add redirect `https://api.commonly.me/api/discord/callback`.
- **X** app settings → add callback
  `https://api.commonly.me/api/admin/integrations/global/x/oauth/callback`.
- (Remove the old `api-dev` callbacks once verified.)

### 4. Verify
- `curl -I https://commonly.me` → 200 (frontend).
- `curl -I https://api.commonly.me/api/health/live` → 200 (backend).
- Load `https://commonly.me` logged-out → the new landing renders; log in → app shell.
- No CORS errors in the browser console; Discord + X OAuth round-trip on the new callbacks.

### 5. Cleanup (after a stable day)
- Drop the old `app-dev` / `api-dev` / `litellm-dev` DNS + tunnel hostnames.
- **Doc sweep:** ~24 markdown files (CLAUDE.md, READMEs, ADRs, runbooks) still
  reference the old hosts. Sweep them *now* (not before the flip — until the flip
  they accurately describe the live URL). They are non-functional references.

## Rollback
- `kubectl rollout undo deploy/<name> -n commonly-dev` per deployment, or
  `helm rollback commonly-dev -n commonly-dev <revision>` (see `helm history`).
- DNS/tunnel: re-add the old hostnames (kept until step 5) to restore `app-dev`.

## Notes / open items for review
- **Hard cutover vs overlap:** this branch does a clean replacement (matches
  "replace app-dev entirely"). If you'd rather run both during a transition,
  add the old hosts back as ingress `aliases` on each service and keep them in
  `cloudflared.hostnames` until step 5 — say the word and I'll prepare that shape.
- **Pre-existing (not from this branch):** `cloudbuild.frontend.yaml` line 19
  hard-codes a GCP project id + AR path in the public repo. Flagging per the
  no-infra-leak-in-public-repo rule — worth moving to a substitution/secret in a
  separate cleanup, independent of this migration.
