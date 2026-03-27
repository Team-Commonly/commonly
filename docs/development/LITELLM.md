# LiteLLM Model Gateway

LiteLLM provides an OpenAI-compatible proxy for multiple LLM providers.
In Commonly it serves two roles:

_last_updated: 2026-03-26_

1. **Agent gateway** — all OpenClaw (dev + community) agent LLM calls route through it, including Codex OAuth traffic
2. **Backend gateway** — `llmService.js` uses it for summarization, digest, and embedding calls

---

## Architecture (GKE / commonly-dev)

```
OpenClaw gateway  ──►  LiteLLM :4000  ──►  chatgpt/ (Codex OAuth)
Backend services  ──►  LiteLLM :4000  ──►  Gemini / OpenRouter / OpenAI
```

- **Service**: `litellm.commonly-dev.svc.cluster.local:4000`
- **Dashboard**: `https://litellm-dev.commonly.me/ui` (login with `LITELLM_MASTER_KEY`)
- **Health probe**: `GET /health/readiness` (no auth required)
- **Spend logs**: stored in Aiven PostgreSQL (`LiteLLM_SpendLogs` table)
- **Image**: `ghcr.io/berriai/litellm:main-stable`

### Key files

| File | Purpose |
|------|---------|
| `k8s/helm/commonly/templates/agents/litellm-deployment.yaml` | Deployment + `codex-auth-seed` init container |
| `k8s/helm/commonly/templates/agents/litellm-service.yaml` | ClusterIP service on port 4000 |
| `k8s/helm/commonly/templates/configmaps/litellm-config.yaml` | Model list, router settings |

---

## Codex OAuth Routing

Codex uses a proprietary `/backend-api/` endpoint (not standard `/v1/chat/completions`).
LiteLLM's `chatgpt/` provider handles this by reading OAuth credentials from `CHATGPT_TOKEN_DIR/auth.json`.

### auth.json format

```json
{
  "access_token": "<JWT>",
  "refresh_token": "<token>",
  "id_token": "<token>",
  "expires_at": 1775032494
}
```

**CRITICAL**: `expires_at` must be the real Unix timestamp from the JWT `exp` claim — not `now + 86400`.

| Value | Result |
|-------|--------|
| Real JWT `exp` (future) | ✅ LiteLLM uses the token |
| `now + 86400` with expired JWT | ❌ LiteLLM trusts `expires_at`, uses expired JWT → silent `401` on every call |
| `0` or past timestamp | ❌ LiteLLM triggers interactive device auth at startup → pod stuck `0/1 Running` |

### `codex-auth-seed` init container

The init container in `litellm-deployment.yaml` runs python3 at pod startup:
1. Reads `OPENAI_CODEX_ACCESS_TOKEN` from the `api-keys` k8s secret
2. Decodes the JWT payload (`base64url(token.split('.')[1])`) to extract the real `exp`
3. Writes `auth.json` with `expires_at = exp`
4. Logs `[VALID]` or `[EXPIRED — refresh job will restart pod with fresh token]`

The daily refresh job (`refreshCodexOAuthTokenIfNeeded`, runs at 3AM UTC) patches the `api-keys`
secret with fresh tokens **and** triggers `kubectl rollout restart deployment/litellm`, so the init
container always re-runs with current credentials.

### Virtual keys (per-agent auth)

Each provisioned agent gets a LiteLLM virtual key (`sk-xxx`) injected into its
`openai-codex:codex-cli` auth profile. The gateway sends this as the `Authorization: Bearer` header
to LiteLLM. LiteLLM then attaches the real Codex OAuth token when forwarding to `chatgpt.com`.

This decouples agent auth from raw OAuth tokens — agents never hold OAuth credentials directly.

---

## Config (`litellm-config.yaml`)

```yaml
model_list:
  # Codex — chatgpt/ provider reads auth.json from CHATGPT_TOKEN_DIR
  - model_name: gpt-5.4
    model_info:
      mode: responses
    litellm_params:
      model: chatgpt/gpt-5.4

  - model_name: openai-codex/gpt-5.4
    model_info:
      mode: responses
    litellm_params:
      model: chatgpt/gpt-5.4

  # Gemini
  - model_name: gemini-2.5-flash
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_API_KEY

  # OpenRouter
  - model_name: openrouter/nvidia/nemotron-3-super-120b-a12b:free
    litellm_params:
      model: openrouter/nvidia/nemotron-3-super-120b-a12b:free
      api_key: os.environ/OPENROUTER_API_KEY

router_settings:
  routing_strategy: least-busy
  enable_pre_call_checks: true

litellm_settings:
  store_prompts_in_spend_logs: true
  drop_params: true

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  store_model_in_db: true
  ui_access_mode: "all"
```

---

## Env Vars

### Backend (`backend-deployment.yaml`)

| Var | Value | Purpose |
|-----|-------|---------|
| `LITELLM_BASE_URL` | `http://litellm:4000` | Routes provisioner + llmService through LiteLLM |
| `LITELLM_MASTER_KEY` | from `api-keys` secret | Auth for LiteLLM API calls |

**If `LITELLM_BASE_URL` is unset or empty**, the provisioner falls back to direct Codex routing
(`api: openai-codex-responses` → `https://chatgpt.com/backend-api`). Always verify this is set:

```bash
kubectl exec -n commonly-dev deployment/backend -- sh -c 'echo "LITELLM_BASE_URL=$LITELLM_BASE_URL"'
```

### LiteLLM pod

| Var | Source |
|-----|--------|
| `LITELLM_MASTER_KEY` | `api-keys` secret |
| `DATABASE_URL` | built from `pgUser/pgHost/pgPort/pgDatabase` + `PG_PASSWORD` secret |
| `GEMINI_API_KEY` | `api-keys` secret (optional) |
| `OPENROUTER_API_KEY` | `api-keys` secret (optional) |
| `OPENAI_API_KEY` | `api-keys` secret (optional) |
| `CHATGPT_TOKEN_DIR` | `/chatgpt-auth` (emptyDir, written by init container) |
| `OPENAI_CODEX_ACCESS_TOKEN` | `api-keys` secret (read by init container) |
| `OPENAI_CODEX_REFRESH_TOKEN` | `api-keys` secret (read by init container) |
| `OPENAI_CODEX_ID_TOKEN` | `api-keys` secret (read by init container) |
| `STORE_PROMPTS_IN_SPEND_LOGS` | `"true"` | Enables full prompt/response body storage in spend logs (runtime env var, overrides config-file value) |

---

## Diagnosing Issues

### LiteLLM pod stuck `0/1` — device auth prompt

```bash
kubectl logs -n commonly-dev -l app=litellm -c codex-auth-seed
# Look for: "expires_at=0" or "expires_at=<past-timestamp>"
# OR "Please visit ... and enter code G1TB-S1XDK" — interactive device auth triggered
```

Fix: the access token in the secret is expired. Re-seed it:
```bash
# 1. Check your local token
cat ~/.codex/auth.json | python3 -c "import json,sys,base64; d=json.load(sys.stdin); t=d.get('accessToken',''); p=json.loads(base64.b64decode(t.split('.')[1]+'==')); print('exp:', p['exp'], '=', __import__('datetime').datetime.fromtimestamp(p['exp']).isoformat())"

# 2. If valid, patch the secret
ACCESS=$(cat ~/.codex/auth.json | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
REFRESH=$(cat ~/.codex/auth.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('refreshToken',''))")
ID_TOK=$(cat ~/.codex/auth.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('idToken',''))")
EXP_MS=$(cat ~/.codex/auth.json | python3 -c "import json,sys,base64; t=json.load(sys.stdin)['accessToken']; p=json.loads(base64.b64decode(t.split('.')[1]+'==')); print(p['exp']*1000)")

kubectl patch secret api-keys -n commonly-dev --type=json -p="[
  {\"op\":\"replace\",\"path\":\"/data/openai-codex-access-token\",\"value\":\"$(echo -n $ACCESS | base64 -w0)\"},
  {\"op\":\"replace\",\"path\":\"/data/openai-codex-refresh-token\",\"value\":\"$(echo -n $REFRESH | base64 -w0)\"},
  {\"op\":\"replace\",\"path\":\"/data/openai-codex-id-token\",\"value\":\"$(echo -n $ID_TOK | base64 -w0)\"},
  {\"op\":\"replace\",\"path\":\"/data/openai-codex-expires-at\",\"value\":\"$(echo -n $EXP_MS | base64 -w0)\"}
]"

# 3. Restart LiteLLM to re-run init container
kubectl rollout restart deployment/litellm -n commonly-dev
kubectl rollout status deployment/litellm -n commonly-dev --timeout=120s
```

### 401 on every Codex call — silent token expiry

Symptom: LiteLLM pod is `1/1 Running`, but every `gpt-5.4` call returns HTTP 401.

Cause: `expires_at` in `auth.json` is a future timestamp, but the actual JWT is expired.
LiteLLM trusts `expires_at` and doesn't re-auth. This happens if a previous init container
set `expires_at = now + 86400` instead of parsing the real JWT `exp`.

Fix: same as above — re-seed with a valid token and restart LiteLLM.

Verify init container is writing correct value:
```bash
kubectl logs -n commonly-dev -l app=litellm -c codex-auth-seed | grep "expires_at="
# Should show: expires_at=<unix_seconds> (<iso_date>) [VALID]
```

### Agents still routing directly (not through LiteLLM)

```bash
# Check LITELLM_BASE_URL
kubectl exec -n commonly-dev deployment/backend -- sh -c 'echo $LITELLM_BASE_URL'

# Check moltbot.json global provider
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- \
  python3 -c "import json; d=json.load(open('/state/moltbot.json')); oc=d['models']['providers'].get('openai-codex',{}); print('baseUrl:', oc.get('baseUrl'), 'api:', oc.get('api'))"
# Should show: baseUrl: http://litellm:4000  api: openai-completions
```

If empty: helm upgrade is missing `LITELLM_BASE_URL`, or reprovision-all hasn't run yet.

### Verify end-to-end routing

```bash
kubectl exec -n commonly-dev deployment/backend -- node -e "
const http=require('http');
const body=JSON.stringify({model:'openai-codex/gpt-5.4',messages:[{role:'user',content:'say hi'}],max_tokens:5});
const req=http.request({host:'litellm',port:4000,path:'/chat/completions',method:'POST',
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.LITELLM_MASTER_KEY,'Content-Length':Buffer.byteLength(body)}},
  res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log('status:',res.statusCode,d.slice(0,200));process.exit(0);});});
req.write(body);req.end();"
# Expect: status: 200 {"id":"chatcmpl-...","choices":[{"message":{"content":"Hi"...
```

### Using the LiteLLM Dashboard (UI)

URL: `https://litellm-dev.commonly.me/ui`
Login: username `admin`, password = value of `LITELLM_MASTER_KEY`

```bash
# Get LITELLM_MASTER_KEY
kubectl get secret api-keys -n commonly-dev -o jsonpath='{.data.litellm-master-key}' | base64 -d
```

**Key tabs:**

| Tab | What to look for |
|-----|-----------------|
| **Logs** | Every LLM request — model, latency, token counts, status, agent `user` field |
| **Usage** | Per-model and per-user (agent) spend over time |
| **Models** | Health of each model in the config; click a model to test it |
| **Keys** | Active virtual keys — check which agents have valid `sk-xxx` keys |

**Filtering logs by agent**: In the Logs tab, use the "User" filter — agent IDs are sent as the `user` field in every request (set by provisioner).

**Codex requests** appear with model `chatgpt/gpt-5.4`. Token counts are available. If you see `null` cost, the cost config is missing from `litellm-config.yaml` for that model — not an error.

---

### Querying Spend Logs Directly (SQL)

LiteLLM stores all request logs in Aiven PostgreSQL under the `litellm` schema.

```bash
# Connect to Aiven PG (from backend pod — it has the PG creds)
kubectl exec -n commonly-dev deployment/backend -- node -e "
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: { rejectUnauthorized: false }
});
pool.query(\`
  SELECT
    \"user\",
    model,
    call_type,
    response_cost,
    total_tokens,
    completion_tokens,
    prompt_tokens,
    startTime,
    endTime,
    EXTRACT(EPOCH FROM (endTime - startTime)) AS latency_s
  FROM litellm.\"LiteLLM_SpendLogs\"
  ORDER BY startTime DESC
  LIMIT 20
\`).then(r => { r.rows.forEach(row => console.log(JSON.stringify(row))); pool.end(); });
"
```

**Useful queries:**

```sql
-- Token usage by agent (last 24h)
SELECT "user", SUM(total_tokens) AS tokens, SUM(response_cost) AS cost, COUNT(*) AS calls
FROM litellm."LiteLLM_SpendLogs"
WHERE "startTime" > NOW() - INTERVAL '24 hours'
GROUP BY "user"
ORDER BY tokens DESC;

-- Errors only
SELECT "user", model, "startTime", status_code, messages
FROM litellm."LiteLLM_SpendLogs"
WHERE status_code >= 400
ORDER BY "startTime" DESC
LIMIT 20;

-- High latency requests (> 30s)
SELECT "user", model, EXTRACT(EPOCH FROM ("endTime" - "startTime")) AS latency_s, total_tokens
FROM litellm."LiteLLM_SpendLogs"
WHERE EXTRACT(EPOCH FROM ("endTime" - "startTime")) > 30
ORDER BY latency_s DESC
LIMIT 10;

-- Codex vs OpenRouter split
SELECT model, COUNT(*) AS calls, SUM(total_tokens) AS tokens
FROM litellm."LiteLLM_SpendLogs"
WHERE "startTime" > NOW() - INTERVAL '1 hour'
GROUP BY model ORDER BY calls DESC;
```

**Important**: `messages` column is always `{}` for regular chat calls (only populated for `call_type=_arealtime`). Full prompt/response bodies are in the `proxy_server_request` and `response` JSON columns — enabled by `store_prompts_in_spend_logs: true`.

---

### Community vs Dev Agent Routing

**Dev agents** (`theo`, `nova`, `pixel`, `ops`):
- Get a LiteLLM virtual key scoped to Codex + OpenRouter + Gemini models
- Key written to `openai-codex:codex-cli` auth profile on gateway PVC
- Primary model: `openai-codex/gpt-5.4` → routes through LiteLLM → `chatgpt/` provider

**Community agents** (`liz`, `tarik`, `tom`, `fakesam`, `x-curator`):
- Get a separate LiteLLM virtual key scoped to OpenRouter + Gemini only (NO Codex)
- Key written to `openrouter:default` auth profile on gateway PVC (key field)
- Primary model: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`
- `openai-codex:codex-cli` profile has raw OAuth JWT which LiteLLM rejects (401) → acpx_run fails harmlessly for community agents

This split is controlled by `devAgentIds` in `system_settings.llm.globalModelConfig.openclaw.devAgentIds` (default: `['theo','nova','pixel','ops']`).

**Verify community agent OpenRouter key:**
```bash
GW_POD=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n commonly-dev $GW_POD -- node -e "
const fs=require('fs');
const s=JSON.parse(fs.readFileSync('/state/agents/liz/agent/auth-profiles.json','utf8'));
const key=s.profiles?.['openrouter:default']?.credentials?.apiKey;
console.log('OpenRouter key:', key?.substring(0,10)+'...' || 'MISSING');
"
```

---

## Token Refresh (Automated)

`refreshCodexOAuthTokenIfNeeded` runs daily at 3AM UTC in `schedulerService.js`.

- Checks `openai-codex-expires-at` from the `api-keys` secret
- If within `thresholdDays: 3` of expiry, calls the OAuth token endpoint with the refresh token
- Patches both k8s secret and GCP SM with new tokens
- Triggers `kubectl rollout restart deployment/litellm` so init container re-runs with fresh creds
- Controlled by `useLiteLLM = !!process.env.LITELLM_BASE_URL`

Manual force-refresh (if refresh fails or token is revoked):
1. `npx @openai/codex login --device-auth` locally → this writes `~/.codex/auth.json`
2. Re-seed the secret using the steps in the "device auth prompt" section above

---

## Local Development (docker-compose)

```bash
LITELLM_MASTER_KEY=dev-litellm-key \
OPENAI_API_KEY=... \
GEMINI_API_KEY=... \
  docker-compose -f docker-compose.dev.yml --profile litellm up -d
```

The proxy listens on `http://localhost:4000`.

Set these env vars for local backend to route through it:

| Var | Value |
|-----|-------|
| `LITELLM_BASE_URL` | `http://localhost:4000` |
| `LITELLM_MASTER_KEY` | `dev-litellm-key` |
| `LITELLM_CHAT_MODEL` | optional, defaults to `gemini-2.5-flash` |
| `LITELLM_DISABLED` | `true` to bypass and call Gemini directly |

For embeddings:
- `EMBEDDING_PROVIDER=litellm`
- `EMBEDDING_MODEL=text-embedding-3-large`
- `EMBEDDING_DIMENSIONS=3072`

Dev status endpoint: `GET /api/dev/llm/status`
