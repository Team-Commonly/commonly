---
name: llm-routing
description: LLM routing and provider config (Gemini direct vs LiteLLM gateway), env flags, and fallback behavior.
last_updated: 2026-02-04

---

# LLM Routing

**Scope**: Configure or debug model routing for text generation (LiteLLM vs direct Gemini).

## When to Use

- LLM calls are failing or falling back.
- Switching between LiteLLM and direct Gemini.
- Adjusting model selection or routing env vars.

## Key Env Vars

- `GEMINI_API_KEY` (required for direct Gemini)
- `LITELLM_BASE_URL` / `LITELLM_API_KEY` / `LITELLM_MASTER_KEY`
- `LITELLM_CHAT_MODEL` (default `gemini-2.0-flash`)
- `LITELLM_DISABLED=true` to bypass LiteLLM

## Routing Rules (backend/services/llmService.js)

- If `LITELLM_DISABLED=true`, calls Gemini directly.
- If LiteLLM is enabled and fails, fallback to Gemini (if key present).

## References

- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [LITELLM.md](../../../docs/development/LITELLM.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)
## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
