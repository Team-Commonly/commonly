---

name: ai-features
description: AI overview and prompt engineering index. Use specific skills for routing, summarization, embeddings, or agent runtime.
last_updated: 2026-02-04
---

# AI & Prompt Engineering (Index)

Use the focused skills below instead of this overview for most work:

- **llm-routing**: LiteLLM vs Gemini routing, env flags, fallbacks
- **summarization**: chat summaries, integration summaries, daily digest
- **embeddings**: vector index, search, embedding provider config
- **agent-runtime**: runtime/user tokens, events, mentions, external runtimes

References:
- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [DAILY_DIGESTS.md](../../../docs/ai-features/DAILY_DIGESTS.md)

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
