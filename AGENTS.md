
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
- `SUMMARIZER_AND_AGENTS.md` (**IMPORTANT**: How automated summaries and intelligent agents work together)
- `development/LITELLM.md` (optional LiteLLM model gateway for local dev)
- Integration providers live in `backend/integrations/providers/` (discord, slack, groupme, telegram, x, instagram).
- Webhook routes for integrations are under `/api/webhooks/<provider>/<integrationId>`.
- `whatsapp/WHATSAPP_INTEGRATION_PLAN.md` (for WhatsApp work)
- `integrations/INTEGRATION_CONTRACT.md` (for any new external integration)
- `integrations/COMMONLY_APP_PLATFORM.md` (for app/installation flow like GitHub Apps)
- `slack/README.md`, `google-chat/README.md`, `groupme/README.md`, `x/README.md`, `instagram/README.md` (integration notes)
- `design/MULTI_AGENT_POSITIONING.md` (competitive framing: context hub + pods)
- `design/MULTI_AGENT_ROADMAP.md` (priorities that reinforce the positioning)
- `design/AGENT_ORCHESTRATOR.md` (runtime contract + local orchestrator + K8s-ready path)
- `design/POD_SKILLS_INDEX.md` (pods as indexed skill packs and team memory)
- `skills/SKILLS_CATALOG.md` (skill catalog + user-friendly import flow)
- `agents/AGENT_RUNTIME.md` (external agent connection API)
- `scripts/generate-awesome-skills-index.js` (catalog index generator)
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
Profile avatars support image uploads via `/api/uploads` (colors still supported). Agent templates may store an `iconUrl` for custom avatars.
Dev ingress must allow multipart uploads for generated avatars (`nginx.ingress.kubernetes.io/proxy-body-size: "10m"` in Helm values) or the UI shows Axios `Network Error` from upstream `413`.
User profile avatar dialog includes a "Generate with AI" option and stores the generated data URI as `profilePicture`.
Agent and user avatar generation share one portrait-first modal (same presets + prompt controls) for consistent output.
Sidebar Apps quick-add cards (Discord/Slack/GroupMe/Telegram) are redirect-only; no inline config inputs. Sidebar also shows connected integration status cards for these providers.
Pod member lists show MVP role labels: **Admin** for the creator, **Member** for others (viewers are read-only and not rendered yet).
Pod admins can remove non-admin human members from the member list.
Agents Hub uses a single filter bar (search, category, install-to pod) and skips “Trending” for now; agent cards are 3-up on desktop.
Agents Hub supports user-created agent templates (private/public) that appear as cards and install as additional instances of the same agent type.
Template cards now resolve install/config state by `(agentName + derived instanceId)` so one OpenClaw template instance (ex: `tarik`) does not mask another (ex: `liz`).
Agents Hub settings include persona + instructions editing (tone, specialties, boundaries, custom instructions).
Agents Hub avatar generation is portrait-first (human headshot framing) with optional `male/female/neutral` guidance and a user custom prompt layered over backend base constraints.
Agents Hub install supports gateway selection/creation for global admins; K8s provisioning restarts the selected gateway deployment.
Agents Hub install dialog supports optional per-agent LLM credentials (Google/Anthropic/OpenAI); custom auth profiles apply on gateway restart.
Agent config supports per-agent skill credential overrides (merged into gateway `skills.entries` on provisioning).
Clawdbot gateway pods seed per-agent `auth-profiles.json` from `GEMINI_API_KEY` at startup so new agents get default auth automatically.
Agents Hub shows an Admin tab for global admins to audit installations, revoke runtime tokens, and uninstall obsolete instances.
Agents Hub Admin tab includes a manual "Run Themed Autonomy" control (calls `POST /api/admin/agents/autonomy/themed-pods/run`).
Daily Digest analytics uses a single view selector to avoid chart crowding.
Post feed supports pod-scoped posts and forum-style categories, with feed filters driven by `?podId=` and `?category=` and a pod ↔ feed redirect flow.
Mobile layout keeps sidebars off-canvas: the main dashboard slides over content with a backdrop, and the chat members panel overlays full screen on small devices.
Chat members panel defaults to collapsed on pod entry.
Mobile breakpoint guard: keep pod chat layout full-width at <=768px (avoid `left: 50%` positioning).
Agent mentions should use instance ids or display slugs (e.g. `@tarik`) instead of base agent names to avoid ambiguity.
Pod chat message rendering should map agent instance usernames (e.g. `openclaw-liz`) to installed-agent display names and icon URLs immediately, including live Socket.io `newMessage` events (no refresh required).
OpenClaw silent token `NO_REPLY` only suppresses output when it is the entire reply; do not append it to normal text.
OpenClaw queue settings do not support per-channel overrides like `messages.queue.byChannel.commonly`; use global `messages.queue` settings instead.
Agents Hub (`/agents`) is for registry-based agent installs (pod-native profiles). Apps Marketplace (`/apps`) is for webhook/integration apps.
Agent installs support selecting target pods; pod admins (and installers) can remove agents from pods.
Pod sidebar lists installed agents with a Manage link to Agent Hub and admin/installer removal.
Pod member online indicators are driven by Socket.io `podPresence` events.
Agent Ensemble pods (`type="agent-ensemble"`) use the standard chat UI plus an Agent Ensemble sidebar panel for participant roles and start/pause/resume controls.
Agent Ensemble participants with role **Observer** do not take turns; at least two speaking participants are required to save/start discussions. Global admins can save ensemble settings.

## Developer utilities

- The backend exposes documentation at `/api/docs/backend`.
- The frontend provides a simple API testing page at `/dev/api` which loads the docs and allows ad-hoc requests.
- The frontend provides a pod context inspector at `/dev/pod-context` to view structured pod context (including LLM markdown skills) from `/api/pods/:id/context`.
- Gateway registry (admin): `/api/gateways` manages gateway entries (local/remote/K8s).
- Shared gateway skill credentials (admin): `/api/skills/gateway-credentials` stores env vars under `skills.entries` for the selected gateway, plus optional `apiKey` for skills that declare a primary API key.
- K8s Helm values: `k8s/helm/commonly/values.yaml` for default pool, `k8s/helm/commonly/values-dev.yaml` for dev pool. Build backend with `gcloud builds submit --config cloudbuild.backend.yaml .`, rollout with `kubectl set image deployment/backend ...`, and restart `clawdbot-gateway` when runtime configs/auth profiles change.
- Integration catalog metadata is available at `/api/integrations/catalog` (manifest-driven entries + per-user stats).
- K8s agent provisioning can be pinned to a node pool by setting `AGENT_PROVISIONER_NODE_POOL` (e.g., `dev`) on the backend deployment; leave empty to schedule on default nodes.
- K8s Helm now includes a `clawdbot-gateway` deployment + service; it expects `CLAWDBOT_GATEWAY_TOKEN` in the `api-keys` secret and uses the `gcr.io/commonly-test/clawdbot-gateway:latest` image.
- Creating a gateway with `mode=k8s` provisions a dedicated gateway Deployment/Service (`gateway-<slug>`) and a workspace PVC in the target namespace.
- Dev Postgres CA is managed via a manual `postgres-ca-cert` secret (set `configMaps.postgresCA.enabled=false` in `values-dev.yaml`).
- Social feed integrations (X/Instagram) are poll-based; scheduler syncs external posts into pod feeds and buffers for summary.
- Pod context metadata is available at `/api/pods/:id/context` and can synthesize LLM markdown skills into `PodAsset` records of type `skill` (params: `skillMode`, `skillLimit`, `skillRefreshHours`).
- Pod memory assets can be agent-scoped (`metadata.scope="agent"` + `agentName`/`instanceId`) or pod-shared (`metadata.scope="pod"`); unscoped assets are treated as shared.
- `/dev/pod-context` includes a “Show Summary Content” toggle that renders summary markdown content for quick inspection.
- `/api/pods/:id/context` returns `skillModeUsed` and `skillWarnings` to explain the effective skill synthesis mode.
- Pod memory search endpoints:
  - `GET /api/pods/:id/context/search` (keyword search over PodAssets)
  - `GET /api/pods/:id/context/assets/:assetId` (excerpt read)
- The pod context inspector includes type filters and an auto-load excerpt toggle for faster memory review.
- Skills catalog can be sorted by GitHub stars when the index includes `stars` metadata (`/api/skills/catalog?sort=stars`).
- ChatRoom’s Apps/Integrations cards consume `/api/integrations/catalog` to render provider descriptions in the sidebar; capability chips now live in the built-in integrations section on `/apps`.
- Official marketplace listings are served from `/api/marketplace/official` (manifest at `packages/commonly-marketplace/marketplace.json`).
- Marketplace entries can include `type="mcp-app"` with `mcp.resourceUri` metadata; MCP Apps are listed for discovery and require an MCP-compatible host for UI rendering.
- Use `MARKETPLACE_MANIFEST_URL` to fetch the external marketplace repo manifest (with `MARKETPLACE_MANIFEST_PATH` as a local fallback).
- External provider service stubs live in `external/commonly-provider-services/` (Discord/Slack/Telegram/GroupMe). In-platform providers are legacy.
- The Commonly Bot external runtime is configured in `docker-compose.dev.yml` as `commonly-bot` and expects `COMMONLY_SUMMARIZER_RUNTIME_TOKEN` (runtime) plus optional `COMMONLY_SUMMARIZER_USER_TOKEN` for MCP/REST access.
- External agent service stubs live in `external/commonly-agent-services/` (Commonly Bot, Clawdbot Bridge).
- Clawdbot dev gateway runs via the `clawdbot` docker-compose profile and stores state under `external/clawdbot-state/`.
- Clawdbot Bridge runs in the same `clawdbot` profile and requires `CLAWDBOT_GATEWAY_TOKEN` plus `CLAWDBOT_BRIDGE_TOKEN`.
- Commonly uses `_external/clawdbot/Dockerfile.commonly` by default in `docker-compose.dev.yml` to include Python skill dependencies (ex: `tavily-python`).
- LiteLLM model gateway runs via the `litellm` docker-compose profile with config at `external/litellm/config.yaml`.
- Agent runtime endpoints (token-auth) are under `/api/agents/runtime` with tokens issued via `/api/registry/pods/:podId/agents/:name/runtime-tokens`.
- Agent runtime integration access endpoints are:
  - `GET /api/agents/runtime/pods/:podId/integrations` (scope `integration:read`; legacy alias `integrations:read` accepted)
  - `GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages` (scope `integration:messages:read`)
  - Registry install auto-grants both integration scopes; `heartbeat` events include `payload.availableIntegrations` when agent-access-enabled integrations are available.
- New pods auto-install `commonly-bot` as the default summary agent (`AUTO_INSTALL_DEFAULT_AGENT=0` disables this).
- Hourly summary scheduling is agent-first: backend enqueues `summary.request` events for installed `commonly-bot` instances; legacy direct summarizers run only when `LEGACY_SUMMARIZER_ENABLED=1`.
- Manual summary refresh routes are agent-first:
  - `POST /api/summaries/trigger` (global admin) enqueues summary events (integration + pod summary requests)
  - `POST /api/summaries/pod/:podId/refresh` enqueues a pod `summary.request` and returns the new agent summary when available.
- Provisioning `commonly-bot` runtime from Agents Hub is restricted to global admins.
- Themed pod autonomy runs every 2 hours via `podCurationService` (creates missing themed pods from social feed activity and enqueues `curate` events).
- Global admins can manually trigger themed pod autonomy via `POST /api/admin/agents/autonomy/themed-pods/run` (optional body: `hours`, `minMatches`).
- Runtime tokens can be revoked via `DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId` (Agents Hub uses `registry=commonly-official` when listing agents).
- Shared runtime tokens stored on the bot user authorize all active installations for the agent/instance across pods.
- Agents Hub config also supports designated bot user tokens (scoped permissions) via `/api/registry/pods/:podId/agents/:name/user-token` for MCP/REST access.
- Agents Hub can provision and control local runtimes via `/api/registry/pods/:podId/agents/:name/provision`, `/runtime-status`, `/runtime-start`, `/runtime-stop`, and `/runtime-logs`.
- In K8s, runtime provisioning writes OpenClaw config into the shared gateway by default; global admins can target a custom `gateway-<slug>` gateway. Runtime logs stream from the selected gateway deployment with instance/account filtering.
- Agent runtime WebSocket (`/agents`) replays pending events on connect for the same agent/instance across active pod installs; this prevents mention loss when events are queued during gateway restart/provision windows.
- OpenClaw plugin installs/listing are available via `/api/registry/pods/:podId/agents/:name/plugins` and `/plugins/install` (local gateway only).
- OpenClaw (Cuz) external runtime uses BOTH `OPENCLAW_RUNTIME_TOKEN` (runtime token) and `OPENCLAW_USER_TOKEN` (user token).
- OpenClaw workspace ownership can be forced via `OPENCLAW_WORKSPACE_UID`/`OPENCLAW_WORKSPACE_GID` (defaults to `1000:1000`) to avoid permission mismatches between backend-written skills and the gateway runtime.
- Pod chat supports agent mentions: `@commonly-bot`, `@commonly-ai-agent`, and `@clawdbot-bridge` (aliases `@commonlybot` → `commonly-bot`, `@cuz` → `commonly-ai-agent`, `@clawdbot`) enqueue `chat.mention` events when those agents are installed in the pod.
- Thread comments support agent mentions as well and enqueue `thread.mention` events; agents reply via `/api/agents/runtime/(bot)/threads/:threadId/comments`.
- Agent instance IDs default to `default` (even if the instance name matches the agent name) to avoid duplicate usernames like `agent-agent`.
- Integration create/update routes enforce manifest-required fields when an integration is marked `connected`; draft integrations can still be created but remain `pending` until required config is provided.
- Chat summarization and integration buffer summarization now persist `PodAsset` records so pod context can be retrieved as indexed assets, not only raw text summaries.
- Webhook endpoints now include Slack, GroupMe, and Telegram:
  - `/api/webhooks/slack/:integrationId` (raw-body signature verify)
  - `/api/webhooks/groupme/:integrationId`
  - `/api/webhooks/telegram` (universal bot webhook with optional secret token header)
- Integration summaries are generated from buffered webhook/gateway messages. Discord uses a Gateway listener with Message Content intent enabled and stores messages in `Integration.config.messageBuffer` before hourly summarization.
 - Telegram universal bot uses `/commonly-enable <code>` to link a chat to a pod; per-integration `chatId` is stored in config.
