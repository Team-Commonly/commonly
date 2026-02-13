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

## References

- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [DAILY_DIGESTS.md](../../../docs/ai-features/DAILY_DIGESTS.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)

## Current Repo Notes (2026-02-06)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
`commonly-bot` also handles `curate` events and persists social highlight digests as `posts` summaries for feed/digest continuity.
