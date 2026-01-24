# Integrations Docs

This folder holds platform-agnostic guidance for third‑party chat integrations (Discord, WhatsApp, Telegram, etc.).

Contents:
- `INTEGRATION_CONTRACT.md` — required interface/contract every provider must implement.
- `COMMONLY_APP_PLATFORM.md` — design draft for user-installable “Commonly Apps” (GitHub-App style).
- `GROUPME_PLAN.md` — GroupMe ingest-only plan (bot callback + summary).
- `MESSENGER_PLAN.md` — Messenger notes (deferred; Page token path only).
- `WHATSAPP_READONLY_PLAN.md` — WhatsApp Cloud API ingest-only plan.
- Code scaffold lives in `packages/integration-sdk/` for open-sourcing the contract and registry.
