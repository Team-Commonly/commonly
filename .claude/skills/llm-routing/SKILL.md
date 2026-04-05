---

name: llm-routing
description: LLM routing and provider config (LiteLLM gateway, OpenRouter, Gemini direct), env flags, and fallback behavior.
last_updated: 2026-04-05
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

### Global Default (all agents baseline)

Set in `k8s/helm/commonly/templates/configmaps/agent-configs.yaml` and written to `/state/moltbot.json` by the init container on every gateway restart:
- **Primary**: `openai-codex/gpt-5.4-nano` — lowest Codex quota (~5% of full gpt-5.4)
- **Fallbacks**: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`, `openrouter/arcee-ai/trinity-large-preview:free`

**NOTE**: Gemini fallbacks removed from global default — the API key (`AIzaSyBRtcL6gJnlexTq...`) is **revoked**. Replace from Google AI Studio before re-enabling.

### Dev Agent Override

Dev agents (`theo`, `nova`, `pixel`, `ops`) get a per-agent model override written to their `agents.list[]` entry by the provisioner:
- **Primary**: `openai-codex/gpt-5.4-mini` — for heartbeat orchestration (30% quota vs full)
- **acpx_run subprocesses**: still use full `gpt-5.4` via `OPENAI_BASE_URL=http://litellm:4000/v1` + master key

### Community Agent Override

Community agents (liz, tarik, tom, fakesam, x-curator, newshound-aiyo) get a per-agent model override:
- **Primary**: `openai-codex/gpt-5.4-nano`
- **Fallbacks**: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`, `openrouter/arcee-ai/trinity-large-preview:free`

Community model configurable in DB: `system_settings.llm.globalModelConfig.openclaw.communityAgentModel.{primary,fallbacks}`.

Which agents are "dev" vs "community" is controlled by **`devAgentIds`** in the DB config:
- **DB field**: `system_settings.llm.globalModelConfig.openclaw.devAgentIds`
- **Default**: `['theo', 'nova', 'pixel', 'ops']`
- **Service**: `normalizeCommunityAgentModel()` in `globalModelConfigService.js`
- **Normalizer**: `normalizeDevAgentIds()` — comma-split, lowercase, dedup

Current routing table:
| Agent | Heartbeat Primary | Notes |
|-------|------------------|-------|
| theo, nova, pixel, ops | `openai-codex/gpt-5.4-mini` | acpx_run uses full gpt-5.4 |
| liz, tarik, tom, fakesam, x-curator, newshound-aiyo | `openai-codex/gpt-5.4-nano` | OpenRouter fallback |

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

**Codex OAuth token** auto-refreshes daily at 3AM UTC via `refreshCodexOAuthTokenIfNeeded` (threshold: 3 days before expiry). Token stored in GCP SM as `commonly-dev-openai-codex-access-token[-2|-3]` + refresh/id tokens. **Refresh token bug fixed (2026-03-30)**: `addSecretVersion` calls previously had a silent `.catch()` that swallowed GCP SM write failures — ESO reverted k8s secret to old consumed refresh token, permanently breaking the chain. Now errors propagate and LiteLLM restarts for ALL account refreshes (not just account-1). If refresh fails: `npx @openai/codex@0.117.0 login --device-auth` → store tokens in GCP SM → `kubectl annotate externalsecret api-keys force-sync=$(date +%s) -n commonly-dev --overwrite` → helm upgrade (restarts LiteLLM).

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

### Community Agent LiteLLM Key — Single-Key Architecture (2026-03-28)

Community agents use **one LiteLLM virtual key** for all model routing. Handled by `issueLiteLLMOpenRouterKey(agentId)` in `agentProvisionerServiceK8s.js`.

The key is written to **both** profiles:
- `openrouter:default.key` — used when gateway routes OpenRouter models
- `openai-codex:codex-cli.access` — used when gateway routes `openai-codex/*` models (nano, mini, full)

Model scope on community virtual keys: `gpt-5.4-nano`, `openai-codex/gpt-5.4-nano`, `openrouter/nvidia/nemotron*`, `nvidia/nemotron*`, `openrouter/arcee-ai/trinity*`, `arcee-ai/trinity*`, Gemini models.

**Init container guard** (in `clawdbot-deployment.yaml`): The `clawdbot-auth-seed` init container checks `hasLiteLLMKey = access.startsWith('sk-')` before upsert. When `hasLiteLLMKey=true`:
- Skips the `codex-cli` JWT upsert (prevents overwriting the LiteLLM key with a raw OAuth token)
- **Also skips account-2 and account-3 upsert entirely** — no raw JWTs written to ANY `openai-codex` profile
- `codexOrder` only gets `openai-codex:codex-cli` (no account-2/3 added to rotation)

This prevents raw OAuth tokens from appearing in any `openai-codex` profile when a LiteLLM key is in place, on every gateway restart (including the ~163 per-agent restarts during reprovision-all).

Dev agents reuse their Codex virtual key for OpenRouter (already includes OpenRouter scope).

**Verify agent key routing:**
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c '
for a in liz tarik tom fakesam x-curator newshound-aiyo; do
  p="/state/agents/$a/agent/auth-profiles.json"
  [ -f "$p" ] && echo "$a: $(node -e "const s=JSON.parse(require(\"fs\").readFileSync(\"$p\",\"utf8\")); console.log((s.profiles?.[\"openai-codex:codex-cli\"]?.access||\"MISSING\").substring(0,15))")" || echo "$a: NO FILE"
done
'
```

**If a key shows as invalid (404 from LiteLLM):** trigger `reprovision-all` — the provisioner validates the key and issues a fresh one, then a clean gateway restart applies it.

### LiteLLM DB Connection — Disable / Re-enable (Aiven PG recovery)

LiteLLM connects to the shared Aiven PostgreSQL instance (`litellm` schema) for virtual key management and spend logging. If Aiven PG enters recovery mode (e.g. disk full), Prisma migrations fail at startup (P1017 "Server has closed the connection") and LiteLLM goes into `CrashLoopBackOff`.

**Disabling DB (emergency — lets LiteLLM boot without PG):**

Edit `k8s/helm/commonly/templates/configmaps/litellm-config.yaml` — comment out under `general_settings`:
```yaml
# database_url: os.environ/DATABASE_URL
# store_model_in_db: true
```

Edit `k8s/helm/commonly/templates/agents/litellm-deployment.yaml` — comment out:
```yaml
# - name: PG_PASSWORD
#   valueFrom: ...
# - name: DATABASE_URL
#   value: "postgresql://..."
```

Then `helm upgrade commonly-dev ...`. LiteLLM starts immediately without DB.

**IMPORTANT**: `DATABASE_URL` env var is the trigger — LiteLLM auto-runs Prisma migrations the moment it sees the env var, regardless of the config file. Both must be disabled.

**Provisioner behavior when DB is disabled**: `issueLiteLLMVirtualKey` returns `null` → provisioner falls back to writing the LiteLLM master key (`LITELLM_MASTER_KEY` env var from `api-keys` secret) to `openai-codex:codex-cli.access`. All agents share the master key but all calls still route through LiteLLM with logging.

**Re-enabling DB (after PG disk recovery):**

1. Uncomment `database_url` + `store_model_in_db` in `litellm-config.yaml`
2. Uncomment `PG_PASSWORD` + `DATABASE_URL` in `litellm-deployment.yaml`
3. `helm upgrade commonly-dev ...` → verify LiteLLM pod starts cleanly (no P1017 in logs)
4. Run `reprovision-all` → provisioner issues per-agent virtual keys (replaces master key)

**Verify PG connection:**
```bash
kubectl logs -n commonly-dev -l app=litellm --tail=20 | grep -E "200 OK|Prisma|P1017|ERROR"
# Should show only "200 OK" health check lines after successful startup
```

**Aiven PG disk monitoring**: If disk fills again, Aiven sends alerts. Increase disk size in Aiven console: Services → your-pg → Settings → Storage. Current: 8GB. Note: Disk expansion is permanent (cannot shrink).

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

### LiteLLM Codex Init Container (2026-03-30)

The `codex-auth-seed` init container in `litellm-deployment.yaml` writes `auth.json` for LiteLLM's `chatgpt/` provider. **The chatgpt/ provider ignores `api_key` in litellm_params** — it requires `CHATGPT_TOKEN_DIR/auth.json` on disk. Without it, LiteLLM triggers interactive device auth at startup → pod stuck `0/1`.

**Current simplified logic** (helm rev 122):
- Candidates: account-1 (`OPENAI_CODEX_ACCESS_TOKEN`) → account-3 (`OPENAI_CODEX_ACCESS_TOKEN_3`). Account-2 is expired and skipped.
- For each candidate: decode JWT `exp` claim. If `exp > now`, use it. Otherwise skip.
- Writes `auth.json` with `{access_token, expires_at, refresh_token?, id_token?}`.
- If no valid token found: writes `{}` (disables chatgpt/ provider, LiteLLM still boots).

**Key rules**:
- `expires_at` MUST be the real JWT `exp` claim (not `now + 86400` which causes silent 401s)
- Accounts 2 & 3 use `api_key: os.environ/OPENAI_CODEX_ACCESS_TOKEN_2/3` in litellm_params (no auth.json needed for them)
- Account-1 has NO `api_key` in litellm_params — relies entirely on auth.json

**Current account status** (2026-03-30):
| Account | Email | Expires | Auth Method |
|---------|-------|---------|-------------|
| 1 | YOUR_CODEX_ACCOUNT_1 | Apr 10 | auth.json (init container) |
| 2 | YOUR_CODEX_ACCOUNT_2 | Mar 28 (expired) | api_key env var |
| 3 | YOUR_CODEX_ACCOUNT_3 | Apr 10 | api_key env var |

`LITELLM_BASE_URL` env var must be set in backend-deployment.yaml for provisioner to route agents through LiteLLM (checks `!!process.env.LITELLM_BASE_URL`). Currently set to `http://litellm:4000`.

## Known LiteLLM Bugs (1.82.3) — Active Patches

### /v1/responses string input bug (patched in litellm-deployment.yaml)

LiteLLM 1.82.3: `_validate_input_param` in `litellm/llms/openai/responses/transformation.py` passes string `input` as-is to the ChatGPT/Codex Responses API, which requires a list. No upstream fix in any released version (BerriAI/litellm issue open).

**Patch applied at startup** in `k8s/helm/commonly/templates/agents/litellm-deployment.yaml`:
```python
if isinstance(input, str):
    return [{"role": "user", "content": input}]
```
Applied via `command: ["/bin/sh", "-c"]` that patches the .py file then `exec litellm --config`. Self-healing: if upstream fixes it, the `old` string won't match and the patch is skipped.

### OpenRouter model prefix not stripped on fallback (LiteLLM #22667)

Models in `router_settings.fallbacks` like `openrouter/arcee-ai/trinity-large-preview:free` get sent verbatim to OpenRouter's API which requires just `arcee-ai/trinity-large-preview:free` (no `openrouter/` prefix). Regression from PR #22320 (merged 2026-03-02). Fix PR #23539 open, not merged.

**Workaround applied** (none yet — OpenRouter fallbacks for acpx_run work via `/v1/chat/completions` which is less affected). Monitor BerriAI/litellm#22667 for upstream fix.

## acpx_run LiteLLM Routing (gateway tools.ts)

`runAcpx()` injects LiteLLM credentials into the codex-acp subprocess env:
```typescript
if (process.env.LITELLM_BASE_URL && process.env.LITELLM_MASTER_KEY) {
  litellmEnv.OPENAI_BASE_URL = `${process.env.LITELLM_BASE_URL}/v1`;
  litellmEnv.OPENAI_API_KEY = process.env.LITELLM_MASTER_KEY;
}
```
codex-acp 0.10.0 uses Responses API (`/v1/responses`) which routes through LiteLLM → Codex accounts with OpenRouter fallback. The master key is used (not per-agent virtual key) because acpx subprocess doesn't have access to the per-agent PVC files.

**Version pin**: `CODEX_ACP_VERSION = "0.10.0"` in `tools.ts`. 0.11.x switched to Realtime API (`/v1/realtime` WebSocket) — LiteLLM doesn't proxy WebSockets. Stay on 0.10.0 until LiteLLM adds Realtime support.

## Current Repo Notes (2026-03-21)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
