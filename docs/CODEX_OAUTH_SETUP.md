# OpenAI Codex OAuth Setup

One-time setup to authenticate the gateway with OpenAI Codex via OAuth.
Tokens are stored on the PVC and auto-refresh — this only needs to be done once per cluster.

## Steps

### 1. Get the current gateway pod name

```bash
kubectl get pods -n commonly-dev -l app=clawdbot-gateway --no-headers
```

### 2. Copy the OAuth helper script to the pod

> Note: `openclaw models auth login --provider openai-codex` requires a provider plugin
> that is not bundled in the gateway image. Use this script instead — it calls the
> OAuth library directly.

```bash
curl -o /tmp/codex-oauth.js https://raw.githubusercontent.com/Team-Commonly/commonly/v1.0.x/docs/scripts/codex-oauth.js
kubectl cp /tmp/codex-oauth.js commonly-dev/<pod-name>:/tmp/codex-oauth.js
```

Or write it inline — the script is at `docs/scripts/codex-oauth.js` in this repo.

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

### 5. Copy the full URL from the browser address bar

Copy the entire `http://localhost:1455/auth/callback?code=...&state=...` URL
and paste it back into the terminal when prompted.

### 6. Verify tokens were written

```bash
cat /state/agents/*/agent/auth-profiles.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
for k, v in d.get('profiles', {}).items():
    print(k, v.get('type'), v.get('provider'))
"
```

You should see a line like:
```
openai-codex:codex-cli  oauth  openai-codex
```

### 6. Select Codex as the agent model

In the Agents Hub UI, open any agent's config dialog, set the model to:
**OpenAI Codex gpt-5.3 (OAuth required)**

Then save. The next reprovision will write the `openai-codex` provider config
and `auth.profiles` OAuth entry into `moltbot.json`.

Gemini models are automatically kept as fallbacks:
`gemini-2.5-flash → gemini-2.5-flash-lite → gemini-2.0-flash`

---

## Token Refresh

Refresh is fully automatic — no sidecar or cron job needed.

- The gateway checks the `expires` timestamp before each model call
- If expired, it calls `https://auth.openai.com/oauth/token` with `grant_type=refresh_token`
- Updated tokens are written back to `auth-profiles.json` on the PVC under a file lock
- Tokens survive pod restarts as long as the PVC is intact

The only way tokens become permanently invalid:
- PVC is deleted (full cluster teardown)
- Refresh token expires due to >30–90 days of gateway inactivity

---

## Re-running After Pod Change

The pod name changes on redeploy. Get the current pod name first:

```bash
kubectl get pods -n commonly-dev -l app=clawdbot-gateway --no-headers
```

Then repeat Step 1 with the new pod name. Since `auth-profiles.json` already
exists on the PVC, Step 2–4 are only needed if the tokens have expired.
