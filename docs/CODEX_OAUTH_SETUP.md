# OpenAI Codex OAuth Setup

> ⚠️ **Outdated for the current dev cluster.** The flow below describes a
> manual `kubectl cp` of `docs/scripts/codex-oauth.js` into the gateway pod —
> it predates the LiteLLM-mediated routing and the `codex-auth-rotator`
> sidecar. For the dev cluster (`commonly-493005`), use the modern flow in
> [`docs/development/LITELLM.md`](development/LITELLM.md) "Refreshing a
> Codex account's tokens": `npx -y @openai/codex login` locally, push tokens
> to GCP Secret Manager, force ESO sync, restart LiteLLM. The init container
> handles seeding; the rotator handles multi-account 429 failover.
>
> Keep this doc only for **bootstrapping a brand-new cluster from scratch**
> where GCP SM doesn't have any Codex tokens yet and a self-hoster has only
> a kubectl context. For day-to-day token refresh, follow LITELLM.md.

One-time setup to authenticate the gateway with OpenAI Codex via OAuth.
Tokens are persisted in the K8s Secret and auto-refresh — after completing these steps
once, all existing and future agents get Codex automatically.

## Steps

### 1. Get the current gateway pod name

```bash
kubectl get pods -n commonly-dev -l app=clawdbot-gateway --no-headers
```

### 2. Copy the OAuth helper script to the pod

> Note: `openclaw models auth login --provider openai-codex` requires a provider plugin
> not bundled in the gateway image. Use this script instead — it calls the OAuth library directly.

```bash
kubectl cp docs/scripts/codex-oauth.js commonly-dev/<pod-name>:/tmp/codex-oauth.js
```

### 3. Run the script interactively

```bash
kubectl exec -it -n commonly-dev <pod-name> -- node /tmp/codex-oauth.js
```

It will print the auth URL:

```
=== Open this URL in your LOCAL browser ===

https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMo...

===========================================

Paste the redirect URL (http://localhost:1455/auth/callback?...)
>
```

### 4. Open the URL in your local browser

Sign in with your OpenAI account. After sign-in, the browser will redirect to:

```
http://localhost:1455/auth/callback?code=XXX&state=YYY
```

This page will **fail to load** — that is expected. Nothing needs to be running on port 1455.

### 5. Paste the redirect URL

Copy the entire `http://localhost:1455/auth/callback?code=...&state=...` URL from the
browser address bar and paste it back into the terminal when prompted.

The script writes tokens to all existing agent `auth-profiles.json` files on the PVC,
then prints a `kubectl` command.

### 6. Run the printed kubectl command locally

The script outputs a command like:

```bash
kubectl create secret generic api-keys \
  --from-literal=openai-codex-access-token='<access>' \
  --from-literal=openai-codex-refresh-token='<refresh>' \
  --from-literal=openai-codex-expires-at='<epoch_ms>' \
  -n commonly-dev --dry-run=client -o yaml | kubectl apply -f -
```

**Run this on your local machine.** This persists tokens in the K8s Secret so that:
- New agents get Codex tokens automatically via the init container
- Tokens survive PVC deletion or full cluster redeployment

### 7. Select Codex as the agent model

In the Agents Hub UI, open any agent's config dialog, set the model to:
**OpenAI Codex gpt-5.3 (OAuth required)** → save.

The next reprovision writes the `openai-codex` provider config and `auth.profiles`
OAuth entry into `moltbot.json`. Gemini models are kept as automatic fallbacks:
`gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash`

---

## How Persistence Works

```
OAuth flow (one-time)
  → tokens written to /state/agents/*/agent/auth-profiles.json (PVC)
  → tokens saved to K8s Secret api-keys (openai-codex-access-token etc.)

Pod restart / new deployment
  → init container runs
  → reads tokens from K8s Secret
  → upserts openai-codex:codex-cli profile into each auth-profiles.json
    (only overwrites if K8s secret has newer expiry than what's on disk)

New agent provisioned
  → init container creates fresh auth-profiles.json
  → seeds Codex OAuth profile from K8s Secret automatically

Live token refresh (ongoing, automatic)
  → gateway checks expires before each model call
  → if expired: calls auth.openai.com with refresh_token → new tokens
  → written back to auth-profiles.json on PVC under file lock
  → K8s Secret stays as a seed/fallback (may lag behind live-refreshed tokens)
```

---

## Token Refresh

Fully automatic — no sidecar or cron job needed.

- Gateway checks `expires` timestamp before each model call
- If expired: calls `https://auth.openai.com/oauth/token` with `grant_type=refresh_token`
- Updated tokens written back to `auth-profiles.json` on PVC under file lock

Tokens become invalid only if:
- Refresh token expires from **>30–90 days of gateway inactivity**
- In that case: re-run this setup from Step 1

---

## Re-running After Cluster Teardown / PVC Loss

If the PVC is lost but the K8s Secret still exists, just restart the gateway —
the init container re-seeds all agent profiles from the K8s Secret automatically.
No OAuth browser flow needed.

If both PVC and Secret are lost, re-run from Step 1.
