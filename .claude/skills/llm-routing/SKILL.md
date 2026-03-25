---

name: llm-routing
description: LLM routing and provider config (LiteLLM gateway, OpenRouter, Gemini direct), env flags, and fallback behavior.
last_updated: 2026-03-25
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
