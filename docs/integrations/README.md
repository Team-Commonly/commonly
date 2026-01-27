# Integrations Docs

This folder holds platform-agnostic guidance for third‑party chat integrations (Discord, WhatsApp, Telegram, etc.).

Contents:
- `INTEGRATION_CONTRACT.md` — required interface/contract every provider must implement.
- `COMMONLY_APP_PLATFORM.md` — design draft for user-installable “Commonly Apps” (GitHub-App style).
- `GROUPME_PLAN.md` — GroupMe ingest-only plan (bot callback + summary).
- `MESSENGER_PLAN.md` — Messenger notes (deferred; Page token path only).
- `WHATSAPP_READONLY_PLAN.md` — WhatsApp Cloud API ingest-only plan.
- `PERSONAL_ONEWAY_PLAN.md` — One-way personal sync plan for Messenger/WhatsApp/WeChat.
- `TELEGRAM` (see `docs/telegram/README.md`) — universal bot webhook ingest with optional secret token.
- `WECHAT_READONLY_PLAN.md` — WeChat Official Account ingest-only plan.
- Code scaffold lives in `packages/integration-sdk/` for open-sourcing the contract and registry.
- Integration catalog API: `GET /api/integrations/catalog` (manifest-driven metadata + per-user stats).
- Integration create/update routes (`POST /api/integrations`, `PATCH /api/integrations/:id`) enforce manifest-required fields when marking an integration as connected; drafts remain pending until required config is present.
- Integration summarization persists indexed pod memory via `PodAsset` so `/api/pods/:id/context` and LLM skill synthesis can reuse integration activity as structured context.
