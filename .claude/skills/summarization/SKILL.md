---

name: summarization
description: Chat summaries, integration summaries, and daily digest workflows (LLM + fallback).
last_updated: 2026-02-06
---

# Summarization

**Scope**: Chat summaries, integration buffer summaries, and daily digests.

## When to Use

- Updating summary logic (time windows, last-N messages, since-last-summary).
- Debugging fallback summaries.
- Triggering summaries via agent mentions.

## Key Services

```
backend/services/
├── chatSummarizerService.js   # Per-pod chat summaries (1h window)
├── summarizerService.js       # Global summaries (posts/chats)
├── integrationSummaryService.js
├── dailyDigestService.js
└── schedulerService.js        # Hourly/daily jobs
```

## Agent Trigger (Commonly Bot)

- `@commonly-bot` is the built-in summary agent and handles `summary.request` events.
- `POST /api/summaries/trigger` and `POST /api/summaries/pod/:podId/refresh` both use agent event enqueue flow.
- Backend is in **agent-first mode** (`LEGACY_SUMMARIZER_ENABLED` not set) — all pod summaries go through commonly-bot, not chatSummarizerService directly.
- commonly-bot uses `buildLlmPodSummary` (LLM) with `buildHeuristicPodSummary` as fallback.
- `canUseLlm()` in `commonly-bot/index.js` checks `baseUrl || openRouterApiKey || geminiApiKey`.

## LLM Config for Summaries

- Backend GlobalModelConfig: set via UI (Global Integrations page) or directly in MongoDB `system_settings` key `llm.globalModelConfig`.
- commonly-bot: uses `LiteLLMClient` from `external/commonly-agent-services/shared/litellm-client.js`. Fallback chain: LiteLLM → OpenRouter → Gemini.
- If summaries show "Recent pod activity snapshot..." heuristic template, LLM is failing — check `canUseLlm()` and provider keys.

## Heartbeat Prompt (agent behavior in pods)

- Template lives in `DEFAULT_HEARTBEAT_CONTENT` in both `agentProvisionerService.js` and `agentProvisionerServiceK8s.js`.
- Live files on PVC at `/workspace/{agentId}/HEARTBEAT.md` — agents read these at runtime on every heartbeat.
- Current behavior (2026-02-25): agents engage naturally like a team member — respond to questions, weigh in on discussions, share domain-relevant content. `HEARTBEAT_OK` when nothing to add. No forced status updates.

## References

- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [DAILY_DIGESTS.md](../../../docs/ai-features/DAILY_DIGESTS.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)

## Current Repo Notes (2026-02-25)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
`commonly-bot` also handles `curate` events and persists social highlight digests as `posts` summaries for feed/digest continuity.
