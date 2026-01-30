
# Codex Agent Instructions

This repository is split into a backend API and a frontend React
application.  Everything is containerised via `docker-compose` for local
development.

## Project structure

- `backend/` – Node.js/Express API. Uses MongoDB and PostgreSQL and has
  its own Jest test suite.
- `frontend/` – React application bootstrapped with `react-scripts`.
- `docs/` – Detailed architecture and development docs.
- `docs/design/` – Design proposals for new features.
- `docker-compose.yml` – Spins up the full stack locally.
- `package.json` in the repo root – exposes lint scripts that call into
  each package.

## Architecture overview

Commonly follows a client–server model. The backend exposes a REST API
with Socket.io for real-time features. Data is stored in MongoDB (general
app data) and PostgreSQL (chat). The frontend communicates with the API
and renders the user interface using React and Material-UI. See the
documents in `docs/` for full details.

## Reading documentation

Always read the documentation in `docs/` before diving into other
directories. The following files outline the architecture, API endpoints
and development conventions:

- `ARCHITECTURE.md`
- `BACKEND.md`
- `FRONTEND.md`
- `DATABASE.md`
- `DEPLOYMENT.md`
- `LINTING.md`
- `development/LITELLM.md` (optional LiteLLM model gateway for local dev)
- Integration providers live in `backend/integrations/providers/` (discord, slack, groupme, telegram).
- Webhook routes for integrations are under `/api/webhooks/<provider>/<integrationId>`.
- `whatsapp/WHATSAPP_INTEGRATION_PLAN.md` (for WhatsApp work)
- `integrations/INTEGRATION_CONTRACT.md` (for any new external integration)
- `integrations/COMMONLY_APP_PLATFORM.md` (for app/installation flow like GitHub Apps)
- `slack/README.md`, `google-chat/README.md`, `groupme/README.md` (integration notes)
- `design/MULTI_AGENT_POSITIONING.md` (competitive framing: context hub + pods)
- `design/MULTI_AGENT_ROADMAP.md` (priorities that reinforce the positioning)
- `design/POD_SKILLS_INDEX.md` (pods as indexed skill packs and team memory)
- `agents/CLAWDBOT.md` (Clawdbot/Moltbot integration and dev setup)

Design documents in `docs/design/` provide additional details for upcoming
features. Review them and add new design docs when planning major
functionality.

Use these documents and any relevant design docs as a reference when
implementing new features or updating existing code.
When you add or modify features, update the relevant docs and this AGENTS file so future agents have accurate guidance.

## Running tests

- **Backend**: run `npm test` from the `backend` directory.
- **Frontend**: run `npm test` from the `frontend` directory.

## Running lint

Run `npm lint` from the repository root. This invokes the lint scripts for both backend and frontend.

## Files to ignore

Skip dependency and build directories when browsing the repository:

- `node_modules/`
- `build/` or `dist/`
- `.env`
- `.vscode/` or `.idea/`

These folders are generated artifacts or configuration files that aren't

## Workflow

When modifying code in either package:
1. Run `npm lint` at the repo root.
2. Run `npm test` in the affected package(s).

 - Always add or update tests when introducing new features. This applies to both the backend and the frontend. Prioritise expanding overall test coverage.
These commands require no additional setup other than installing dependencies (already included in the repository).

## Local development note

The dev backend container installs dependencies on first boot if `/app/node_modules` is empty, so the first `./dev.sh up` may take longer.

## Frontend UI note

Chat and thread composers share a consistent layout (tool cluster + multiline input + labeled send button). Keep file uploads on label-wrapped inputs so icon buttons reliably open the picker.
Sidebar Apps quick-add cards (Discord/Slack/GroupMe/Telegram) are redirect-only; no inline config inputs. Sidebar also shows connected integration status cards for these providers.
Pod member lists show MVP role labels: **Admin** for the creator, **Member** for others (viewers are read-only and not rendered yet).
Pod admins can remove non-admin human members from the member list.
Agents Hub uses a single filter bar (search, category, install-to pod) and skips “Trending” for now; agent cards are 3-up on desktop.
Daily Digest analytics uses a single view selector to avoid chart crowding.
Mobile layout keeps sidebars off-canvas: the main dashboard slides over content with a backdrop, and the chat members panel overlays full screen on small devices.
Chat members panel defaults to collapsed on pod entry.
Mobile breakpoint guard: keep pod chat layout full-width at <=768px (avoid `left: 50%` positioning).
Agents Hub (`/agents`) is for registry-based agent installs (pod-native profiles). Apps Marketplace (`/apps`) is for webhook/integration apps.
Agent installs support selecting target pods; pod admins (and installers) can remove agents from pods.
Pod sidebar lists installed agents with a Manage link to Agent Hub and admin/installer removal.
Pod member online indicators are driven by Socket.io `podPresence` events.

## Developer utilities

- The backend exposes documentation at `/api/docs/backend`.
- The frontend provides a simple API testing page at `/dev/api` which loads the docs and allows ad-hoc requests.
- The frontend provides a pod context inspector at `/dev/pod-context` to view structured pod context (including LLM markdown skills) from `/api/pods/:id/context`.
- Integration catalog metadata is available at `/api/integrations/catalog` (manifest-driven entries + per-user stats).
- Pod context metadata is available at `/api/pods/:id/context` and can synthesize LLM markdown skills into `PodAsset` records of type `skill` (params: `skillMode`, `skillLimit`, `skillRefreshHours`).
- `/dev/pod-context` includes a “Show Summary Content” toggle that renders summary markdown content for quick inspection.
- `/api/pods/:id/context` returns `skillModeUsed` and `skillWarnings` to explain the effective skill synthesis mode.
- Pod memory search endpoints:
  - `GET /api/pods/:id/context/search` (keyword search over PodAssets)
  - `GET /api/pods/:id/context/assets/:assetId` (excerpt read)
- The pod context inspector includes type filters and an auto-load excerpt toggle for faster memory review.
- ChatRoom’s Apps/Integrations cards consume `/api/integrations/catalog` to render provider descriptions in the sidebar; capability chips now live in the built-in integrations section on `/apps`.
- Official marketplace listings are served from `/api/marketplace/official` (manifest at `packages/commonly-marketplace/marketplace.json`).
- Marketplace entries can include `type="mcp-app"` with `mcp.resourceUri` metadata; MCP Apps are listed for discovery and require an MCP-compatible host for UI rendering.
- Use `MARKETPLACE_MANIFEST_URL` to fetch the external marketplace repo manifest (with `MARKETPLACE_MANIFEST_PATH` as a local fallback).
- External provider service stubs live in `external/commonly-provider-services/` (Discord/Slack/Telegram/GroupMe). In-platform providers are legacy.
- The Commonly Bot external runtime is configured in `docker-compose.dev.yml` as `commonly-bot` and expects `COMMONLY_BOT_TOKEN`.
- External agent service stubs live in `external/commonly-agent-services/` (Commonly Bot, Clawdbot Bridge).
- Clawdbot dev gateway runs via the `clawdbot` docker-compose profile and stores state under `external/clawdbot-state/`.
- Clawdbot Bridge runs in the same `clawdbot` profile and requires `CLAWDBOT_GATEWAY_TOKEN` plus `CLAWDBOT_BRIDGE_TOKEN`.
- LiteLLM model gateway runs via the `litellm` docker-compose profile with config at `external/litellm/config.yaml`.
- Agent runtime endpoints (token-auth) are under `/api/agents/runtime` with tokens issued via `/api/registry/pods/:podId/agents/:name/runtime-tokens`.
- Runtime tokens can be revoked via `DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId` (Agents Hub uses `registry=commonly-official` when listing agents).
- Pod chat supports agent mentions: `@commonly-bot` and `@clawdbot-bridge` (aliases `@commonlybot`, `@clawdbot`) enqueue `chat.mention` events when those agents are installed in the pod.
- Integration create/update routes enforce manifest-required fields when an integration is marked `connected`; draft integrations can still be created but remain `pending` until required config is provided.
- Chat summarization and integration buffer summarization now persist `PodAsset` records so pod context can be retrieved as indexed assets, not only raw text summaries.
- Webhook endpoints now include Slack, GroupMe, and Telegram:
  - `/api/webhooks/slack/:integrationId` (raw-body signature verify)
  - `/api/webhooks/groupme/:integrationId`
  - `/api/webhooks/telegram` (universal bot webhook with optional secret token header)
- Integration summaries are generated from buffered webhook/gateway messages. Discord uses a Gateway listener with Message Content intent enabled and stores messages in `Integration.config.messageBuffer` before hourly summarization.
 - Telegram universal bot uses `/commonly-enable <code>` to link a chat to a pod; per-integration `chatId` is stored in config.
