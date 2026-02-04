---

name: summarization
description: Chat summaries, integration summaries, and daily digest workflows (LLM + fallback).
last_updated: 2026-02-04
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

## Mention Trigger (Commonly Summarizer)

- `@commonly-summarizer` enqueues a `summary.request` event and posts the latest summary
- If no summary exists, it generates one before enqueueing

## References

- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [DAILY_DIGESTS.md](../../../docs/ai-features/DAILY_DIGESTS.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
