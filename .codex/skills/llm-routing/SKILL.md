---
name: llm-routing
description: LLM routing and provider config (Gemini direct vs LiteLLM gateway), env flags, and fallback behavior.
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
