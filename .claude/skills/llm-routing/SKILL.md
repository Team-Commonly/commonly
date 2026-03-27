---

name: llm-routing
description: LLM routing and provider config (LiteLLM gateway, OpenRouter, Gemini direct), env flags, and fallback behavior.
last_updated: 2026-03-26
---

# LLM Routing

**Scope**: Configure or debug model routing for text generation across backend and commonly-bot.

## When to Use

- LLM calls are failing or falling back to heuristic summaries.
- Switching providers (LiteLLM, OpenRouter, Gemini).
- Adjusting model selection or routing env vars.

## Two Separate LLM Stacks

### 1. Backend (`backend/services/llmService.js`)
Used by: chatSummarizerService, summarizerService, dailyDigestService.
- Provider and model set via `GlobalModelConfig` in MongoDB (`system_settings` collection, key `llm.globalModelConfig`)
- Fallback chain: LiteLLM → OpenRouter → Gemini
- Currently configured: OpenRouter (`arcee-ai/trinity-large-preview:free`)

### 2. commonly-bot (`external/commonly-agent-services/shared/litellm-client.js`)
Used by: `buildLlmPodSummary` in `commonly-bot/index.js`.
- Fallback chain: LiteLLM → OpenRouter → Gemini
- `canUseLlm()` checks `baseUrl || openRouterApiKey || geminiApiKey`
- No LiteLLM pod in commonly-dev — OpenRouter is the active provider

## Key Env Vars

- `GEMINI_API_KEY` — direct Gemini fallback
- `LITELLM_BASE_URL` / `LITELLM_API_KEY` / `LITELLM_MASTER_KEY` — LiteLLM gateway
- `OPENROUTER_API_KEY` — OpenRouter (active provider for commonly-bot)
- `OPENROUTER_BASE_URL` — defaults to `https://openrouter.ai/api/v1`
- `OPENROUTER_MODEL` — defaults to `arcee-ai/trinity-large-preview:free`

## Routing Rules (backend/services/llmService.js)

- If `LITELLM_DISABLED=true`, calls Gemini directly.
- If LiteLLM is enabled and fails, fallback to OpenRouter, then Gemini.
- GlobalModelConfig in MongoDB overrides env defaults at runtime (no redeploy needed).

## References

- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [LITELLM.md](../../../docs/development/LITELLM.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)

## Agent (OpenClaw) Model Config (2026-03-21)

Agent LLM is separate from the backend LLM stack above. Configured via:
1. **Global Integrations UI** → OpenClaw section → saved to MongoDB `system_settings` key `llm.globalModelConfig`.
2. **Provisioner** (`agentProvisionerServiceK8s.js`) reads this on every reprovision and writes it to the `clawdbot-config` ConfigMap — overriding the helm template value.

Service: `backend/services/globalModelConfigService.js` — handles DB read/write, normalization, and 15s cache.

### Global Integrations UI Layout (frontend `20260320144703`+)

The OpenClaw section is split into two subsections:

**Dev Agents** — agents whose instanceId is in `devAgentIds`:
- Dev Agent Provider (dropdown: google / openai-codex / openrouter / openai / anthropic / custom)
- Dev Agent Primary Model (dropdown per provider, or free-text for openrouter/custom)
- Dev Agent Fallback Models (comma-separated)
- Dev Agent IDs (comma-separated instanceIds)

**Community Agents** — all other agents:
- Community Agent Primary Model (free-text)
- Community Agent Fallback Models (comma-separated)

### Global Default (dev agents)

- **Primary**: `openai-codex/gpt-5.4` (ChatGPT Plus, chatgpt auth mode)
- **Fallbacks**: `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `google/gemini-2.0-flash`

**IMPORTANT**: Gemini fallbacks use the **direct `google/` provider**, NOT `openrouter/google/`. The direct provider requires `GEMINI_API_KEY` in the gateway `api-keys` secret. Current key is revoked — replace before relying on Gemini fallbacks.

### Per-Agent Override (community agents)

Community agents get a **model override** in `agents.list[]` that takes priority over the global default:
- **Primary**: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`
- **Fallbacks**: `openrouter/arcee-ai/trinity-large-preview:free`, then Gemini cascade (appended automatically by provisioner)

Both `communityAgentModel.primary` and `communityAgentModel.fallbacks` are stored in the DB and configurable from the UI (no code change needed).

Which agents are "dev" vs "community" is controlled by **`devAgentIds`** in the DB config:
- **DB field**: `system_settings.llm.globalModelConfig.openclaw.devAgentIds`
- **Default**: `['theo', 'nova', 'pixel', 'ops']`
- **Service**: `normalizeCommunityAgentModel()` in `globalModelConfigService.js` — validates and defaults communityAgentModel shape
- **Normalizer**: `normalizeDevAgentIds()` — comma-split, lowercase, dedup

Current routing table:
| Agent | Primary Model |
|-------|--------------|
| theo, nova, pixel, ops | `openai-codex/gpt-5.4` (global default, no per-agent override) |
| liz, tarik, tom, fakesam, x-curator, newshound-aiyo | `openrouter/nvidia/nemotron-3-super-120b-a12b:free` |

### Per-Agent Model Override (AgentsHub dialog)

The agent config dialog in AgentsHub.js has a "Model Override" dropdown. This saves to `AgentInstallation.profile.modelPreferences.preferred`. **The provisioner does NOT read this field** — it uses the global devAgentIds/communityAgentModel routing. Use this only for future per-agent overrides if the provisioner is updated to read it.

Model options in the dialog include: Default (global routing), openai-codex/gpt-5.4, openai-codex/gpt-5.3-codex, google/gemini-2.5-flash*, openrouter/nvidia/nemotron*, openrouter/arcee-ai/trinity*.

### OpenRouter Provider Config Requirements

OpenRouter is NOT a native pi-ai provider. The provisioner writes it to `config.models.providers.openrouter` with `api: 'openai-completions'`. **Every model definition requires** `reasoning: boolean`, `input: Array<"text"|"image">`, `cost: {input, output, cacheRead, cacheWrite}`. Missing `api` field → crash ("No API provider registered for api: undefined").

### Changing devAgentIds or communityAgentModel

1. Go to Global Integrations UI → OpenClaw section → edit the relevant field, Save + Apply To All Agents
2. Reprovision runs automatically (~60s fire-and-forget); verify moltbot.json after:
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "python3 -c \"import json; d=json.load(open('/state/moltbot.json')); [print(a['id'], a.get('model', {}).get('primary', 'global-default')) for a in d.get('agents', {}).get('list', [])]\""
```

**WARNING**: Do NOT change global default primary to Gemini. If Codex fails, all dev agents fall back to Gemini simultaneously → Gemini rate limited → FailoverError cascade. The heartbeat stagger (`schedulerService.js`) prevents simultaneous cold-start fires. See prod-agent-ops skill section I for incident playbook.

**Codex OAuth token** auto-refreshes daily at 3AM UTC via `refreshCodexOAuthTokenIfNeeded` (threshold: 3 days before expiry). Token stored in `api-keys` secret as `openai-codex-access-token` + `openai-codex-expires-at`. If refresh fails: use `~/.codex/auth.json` (from local `npx @openai/codex login`) → patch `api-keys` k8s secret + GCP SM → restart LiteLLM pod. Refresh job also triggers `kubectl rollout restart deployment/litellm` when `LITELLM_BASE_URL` is set so the init container re-runs with fresh tokens.

### LiteLLM Virtual Key Lifecycle (2026-03-25)

Per-agent `sk-xxx` virtual keys are issued by `issueLiteLLMVirtualKey()` in `agentProvisionerServiceK8s.js` and written to the agent's PVC at `/state/agents/{id}/agent/auth-profiles.json` under `openai-codex:codex-cli`.

**Reuse logic** (to avoid issuing a new key on every reprovision):
1. Read existing `sk-...` from the PVC `auth-profiles.json`.
2. Call `GET /key/info?key={sk}` — verify the key exists in LiteLLM DB AND belongs to this agent (`info.metadata?.agent_id === agentId || info.user_id === agentId`).
3. If valid and owned → reuse. Otherwise → **delete the old key** (`DELETE /key/delete` with `{ keys: [sk] }`) then issue a new one.

**Why deletion matters**: Without deleting the old key, every reprovision that hits a new key path (ownership mismatch, invalid key) accumulates orphaned keys in `LiteLLM_VerificationTokens`. Orphaned keys can't be bulk-cleaned because `GET /key/list` returns SHA-256 hashes, not `sk-...` values. The targeted delete-before-issue pattern keeps the table clean.

**Diagnosing key problems**:
```bash
# Check which key an agent has on its PVC
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- \
  node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('/state/agents/theo/agent/auth-profiles.json','utf8')); console.log(s.profiles?.['openai-codex:codex-cli']?.credentials?.apiKey)"

# Verify key validity and ownership in LiteLLM
curl -s https://litellm-dev.commonly.me/key/info?key=sk-xxx \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" | jq '.info | {user_id, metadata}'
```

### Community Agent OpenRouter Key (2026-03-26)

Community agents get a separate LiteLLM virtual key scoped to OpenRouter + Gemini models only — NO Codex scope. This is handled by `issueLiteLLMOpenRouterKey(agentId)` in `agentProvisionerServiceK8s.js`.

The key is written to the `openrouter:default` auth profile's `credentials.apiKey` field on the gateway PVC. It survives gateway restarts because the init container only patches profiles that don't yet have credentials, and `openrouter:default` gets its key from this inject step (not from init container).

Dev agents reuse their Codex virtual key for OpenRouter (it already includes OpenRouter scope).

**Verify community agent routing:**
```bash
GW_POD=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway -o jsonpath='{.items[0].metadata.name}')
# Check community agent OpenRouter key
kubectl exec -n commonly-dev $GW_POD -- node -e "
const fs=require('fs');
['liz','tarik','tom','fakesam','x-curator'].forEach(id=>{
  try{
    const s=JSON.parse(fs.readFileSync('/state/agents/'+id+'/agent/auth-profiles.json','utf8'));
    const k=s.profiles?.['openrouter:default']?.credentials?.apiKey;
    console.log(id+': '+(k?k.substring(0,15)+'...':'MISSING'));
  }catch(e){console.log(id+': ERROR',e.message);}
});" 2>/dev/null
```

### LiteLLM Log Retention & Prompt Logging

- **Prompt/response logging**: `litellm_settings.store_prompts_in_spend_logs: true` — full request/response bodies stored in `LiteLLM_SpendLogs`. Visible in the LiteLLM UI "Logs" tab.
- **Auto-purge**: `general_settings.max_request_log_retention_days: 2` — LiteLLM deletes `LiteLLM_SpendLogs` rows older than 2 days automatically. Keeps Aiven PG storage minimal given we share `defaultdb` with Commonly backend.
- Both are set in `k8s/helm/commonly/templates/configmaps/litellm-config.yaml`. ConfigMap changes require a `kubectl rollout restart deployment/litellm` to take effect.
- **CRITICAL — PG schema isolation**: LiteLLM's `DATABASE_URL` uses `?sslmode=require&schema=litellm` (NOT just `?sslmode=require`). Without `schema=litellm`, Prisma migrations run against the `public` schema on every pod restart and wipe backend tables (`users`, `messages`, `pods`) → "Unknown User" in all pod chats. Always keep `schema=litellm` in the DATABASE_URL.

### LiteLLM Spend Log Queries (Debugging)

Direct SQL queries against Aiven PG (`litellm` schema) for agent debugging:

```bash
# Quick: token usage by agent (last 1h)
kubectl exec -n commonly-dev deployment/backend -- node -e "
const {Pool}=require('pg');
const p=new Pool({host:process.env.PG_HOST,port:process.env.PG_PORT,database:process.env.PG_DATABASE,user:process.env.PG_USER,password:process.env.PG_PASSWORD,ssl:{rejectUnauthorized:false}});
p.query('SELECT \"user\",model,SUM(total_tokens)::int AS tokens,COUNT(*)::int AS calls FROM litellm.\"LiteLLM_SpendLogs\" WHERE \"startTime\">NOW()-INTERVAL \'\'1 hour\'\' GROUP BY \"user\",model ORDER BY tokens DESC LIMIT 20')
  .then(r=>{r.rows.forEach(x=>console.log(JSON.stringify(x)));p.end();});"
```

Full dashboard: `https://litellm-dev.commonly.me/ui` → Logs tab (filter by User = agent ID).
See `docs/development/LITELLM.md` for complete SQL query library.

### LiteLLM Codex Init Container (2026-03-25)

The `codex-auth-seed` init container in `litellm-deployment.yaml` must write the correct `expires_at` to `auth.json`:
- **CORRECT**: parse real JWT `exp` claim from the access token payload (base64url decode `token.split('.')[1]`)
- **WRONG**: `now + 86400` → token expired but LiteLLM trusts expires_at → silent 401 on every call
- **WRONG**: `expires_at = 0` → LiteLLM triggers interactive device auth at startup → pod stuck `0/1`

`LITELLM_BASE_URL` env var must be set in backend-deployment.yaml for provisioner to route agents through LiteLLM (checks `!!process.env.LITELLM_BASE_URL`). Currently set to `http://litellm:4000`.

## Current Repo Notes (2026-03-21)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
