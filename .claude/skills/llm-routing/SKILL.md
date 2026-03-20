---

name: llm-routing
description: LLM routing and provider config (LiteLLM gateway, OpenRouter, Gemini direct), env flags, and fallback behavior.
last_updated: 2026-03-19
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

## Agent (OpenClaw) Model Config (2026-03-19)

Agent LLM is separate from the backend LLM stack above. Configured via:
1. **Global Integrations UI** → OpenClaw Provider section → saved to MongoDB `system_settings` key `llm.globalModelConfig`.
2. **Provisioner** (`agentProvisionerServiceK8s.js`) reads this on every reprovision and writes it to the `clawdbot-config` ConfigMap — overriding the helm template value.

### Global Default (dev agents)

- **Primary**: `openai-codex/gpt-5.4` (ChatGPT Plus, chatgpt auth mode)
- **Fallbacks**: `openrouter/google/gemini-2.5-flash`, `openrouter/google/gemini-2.5-flash-lite`, `openrouter/google/gemini-2.0-flash-001`

### Per-Agent Override (community agents)

Community agents get a **model override** in `agents.list[]` that takes priority over the global default:
- **Primary**: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`
- **Fallbacks**: `openrouter/arcee-ai/trinity-large-preview:free`, then Gemini cascade

Which agents are "dev" vs "community" is controlled by **`devAgentIds`** in the DB config:
- **DB field**: `system_settings.llm.globalModelConfig.openclaw.devAgentIds`
- **Default**: `['theo', 'nova', 'pixel', 'ops']`
- **UI**: Global Integrations → OpenClaw section → "Dev Agent IDs (use Codex as primary)" text field
- **Normalizer**: `normalizeDevAgentIds()` in `globalModelConfigService.js` — comma-split, lowercase, dedup

Current routing table:
| Agent | Primary Model |
|-------|--------------|
| theo, nova, pixel, ops | `openai-codex/gpt-5.4` (no model override, uses global default) |
| liz, tarik, tom, fakesam, x-curator, newshound-aiyo | `openrouter/nvidia/nemotron-3-super-120b-a12b:free` |

### OpenRouter Provider Config Requirements

OpenRouter is NOT a native pi-ai provider. The provisioner writes it to `config.models.providers.openrouter` with `api: 'openai-completions'`. **Every model definition requires** `reasoning: boolean`, `input: Array<"text"|"image">`, `cost: {input, output, cacheRead, cacheWrite}`. Missing `api` field → crash ("No API provider registered for api: undefined").

### Changing devAgentIds

1. Go to Global Integrations UI → OpenClaw → "Dev Agent IDs" field
2. Edit comma-separated list, Save + Apply To All Agents
3. Reprovision runs automatically (~60s fire-and-forget); verify moltbot.json after:
```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "python3 -c \"import json; d=json.load(open('/state/moltbot.json')); [print(a['id'], a.get('model', {}).get('primary', 'global-default')) for a in d.get('agents', {}).get('list', [])]\""
```

**WARNING**: Do NOT change global default primary to Gemini. If Codex fails, all dev agents fall back to Gemini simultaneously → Gemini rate limited → FailoverError cascade. The heartbeat stagger (`schedulerService.js`) prevents simultaneous cold-start fires. See prod-agent-ops skill section I for incident playbook.

**Codex OAuth token** auto-refreshes daily at 3AM UTC via `refreshCodexOAuthTokenIfNeeded` (threshold: 3 days before expiry). Token stored in `api-keys` secret as `openai-codex-access-token` + `openai-codex-expires-at`. If refresh fails: re-auth with `docs/scripts/codex-oauth.js --device-auth` inside the gateway pod → patch secret → helm upgrade. Script now supports `--account=2` flag for second account.

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
