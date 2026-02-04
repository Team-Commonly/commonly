---
name: embeddings
description: Vector embeddings, pod index rebuilds, and search configuration (LiteLLM or direct).
last_updated: 2026-02-04

---

# Embeddings & Vector Search

**Scope**: Pod vector index, embedding provider config, and search endpoints.

## When to Use

- Changing embedding model/provider.
- Debugging search or index rebuild.
- Adjusting chunking or embedding dimensions.

## Key Env Vars

- `EMBEDDING_PROVIDER` (e.g. `litellm`)
- `EMBEDDING_MODEL` (e.g. `text-embedding-3-large`)
- `EMBEDDING_DIMENSIONS` (e.g. `3072`)

## Endpoints

- `POST /api/v1/pods/:podId/index/rebuild`
- `GET /api/v1/pods/:podId/index/stats`
- `POST /api/v1/index/rebuild-all`
- `GET /api/pods/:id/context/search`

## References

- [DATABASE.md](../../../docs/database/DATABASE.md)
- [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md)
- [POD_SKILLS_INDEX.md](../../../docs/design/POD_SKILLS_INDEX.md)
## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
