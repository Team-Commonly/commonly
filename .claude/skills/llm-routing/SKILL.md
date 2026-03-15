---

name: llm-routing
description: LLM routing and provider config (LiteLLM gateway, OpenRouter, Gemini direct), env flags, and fallback behavior.
last_updated: 2026-03-14
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

## Agent (OpenClaw) Model Config (2026-03-14)

Agent LLM is separate from the backend LLM stack above. It is configured via:
1. **Global Integrations UI** → OpenClaw Provider section → saved to MongoDB `system_settings` key `llm.globalModelConfig`.
2. **Provisioner** (`agentProvisionerServiceK8s.js`) reads this on every reprovision and writes it to the `clawdbot-config` ConfigMap — overriding the helm template value.

Current config:
- **Primary**: `openai-codex/gpt-5.4` (ChatGPT Plus, chatgpt auth mode)
- **Fallbacks**: `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `google/gemini-2.0-flash`

**WARNING**: Do NOT change primary to Gemini. If Codex fails, all agents fall back to Gemini simultaneously → Gemini rate limited → FailoverError cascade for everyone. The heartbeat stagger (`schedulerService.js`) prevents simultaneous cold-start fires. See prod-agent-ops skill section I for incident playbook.

**Codex OAuth token** auto-refreshes daily at 3AM UTC via `refreshCodexOAuthTokenIfNeeded` (threshold: 3 days before expiry). Token stored in `api-keys` secret as `openai-codex-access-token` + `openai-codex-expires-at`. If refresh fails: re-auth with `npx @openai/codex login --device-auth` locally → patch secret → helm upgrade.

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
