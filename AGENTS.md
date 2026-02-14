
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
Chat avatar resolution should be case-insensitive for agent identities (instance username/display slug/display name) so live messages map to the configured agent icon consistently.
Agents Hub `Installed` and `Discover` tabs should resolve agent avatars with the same precedence (`iconUrl` then profile icon fields) to avoid cross-tab mismatch.
Registry installed-agent listing (`/api/registry/pods/:podId/agents`) should prefer matching template `iconUrl` by `(agentName + displayName)` before falling back to registry icon.
Pod browse page (`/pods/:type`) should prioritize pre-entry UX: quick filters (`All`, `Joined`, `Discover`), preview-before-join action, and responsive controls that stay usable on phones.
Pod browse cards should show a role-aware member avatar strip (users/agents, max 4 + overflow) so users can gauge pod makeup before joining.
Pod overview member strips should resolve agent avatars from `/api/registry/pods/:podId/agents` so displayed agent icons match Agent Hub card avatars.
Joined pod cards should display an obvious unread signal (red dot + unread chip) when new pod messages arrive after the local per-pod read cursor.
Pod card lightbulb should toggle between description and cached summary without auto-regenerating; summary regeneration should require the refresh action, and view mode should persist per pod.
Pod chat/member identity clicks should deep-link humans to `/profile/:id` and agents to Agents Hub installed view (`/agents?tab=installed&podId=...&agent=...&instanceId=...&view=overview`).
Agent deep-link pages should be read-only overview for non-managers; only installer, pod admin, or global admin can configure/remove/reprovision.
Dev ingress must allow multipart uploads for generated avatars (`nginx.ingress.kubernetes.io/proxy-body-size: "10m"` in Helm values) or the UI shows Axios `Network Error` from upstream `413`.
User profile avatar dialog includes a "Generate with AI" option and stores the generated data URI as `profilePicture`.
Agent and user avatar generation share one portrait-first modal (same presets + prompt controls) for consistent output.
Sidebar Apps quick-add cards (Discord/Slack/GroupMe/Telegram) are redirect-only; no inline config inputs. Sidebar also shows connected integration status cards for these providers.
Pod member lists show MVP role labels: **Admin** for the creator, **Member** for others (viewers are read-only and not rendered yet).
Pod admins can remove non-admin human members from the member list.
Agents Hub uses a single filter bar (search, category, install-to pod) and skips “Trending” for now; agent cards are 3-up on desktop.
Agents Hub cards should not render 5-star rating UI for now; use that space for clear action buttons and core status metadata on desktop.
Agents Hub includes a Presets tab with categorized suggested agent types, intended usage, and API/tool readiness from `/api/registry/presets`.
Presets also include default skill bundles per agent type with explicit setup states (ready / needs package install / needs API env), plus recommended env-variable checks against built-in OpenClaw skills and Dockerfile.commonly package capabilities.
Presets tab includes category chips and now ships Social presets for curator-style agents (trend scout, amplifier, community host).
Landing page includes a Use Cases section and public detail routes at `/use-cases/:useCaseId` for scenario-led onboarding.
Agents Hub supports user-created agent templates (private/public) that appear as cards and install as additional instances of the same agent type.
Template cards now resolve install/config state by `(agentName + derived instanceId)` so one OpenClaw template instance (ex: `tarik`) does not mask another (ex: `liz`).
Agents Hub settings include persona + instructions editing (tone, specialties, boundaries, custom instructions).
Agents Hub avatar generation is portrait-first (human headshot framing) with optional `male/female/neutral` guidance and a user custom prompt layered over backend base constraints.
Agents Hub install supports gateway selection/creation for global admins; K8s provisioning restarts the selected gateway deployment.
Agents Hub install dialog supports optional per-agent LLM credentials (Google/Anthropic/OpenAI); custom auth profiles apply on gateway restart.
Agent config supports per-agent skill credential overrides (merged into gateway `skills.entries` on provisioning).
OpenClaw runtime skill loading is workspace-first: agent responses use `/workspace/<instanceId>/skills` plus remote eligibility checks. `/workspace/_master` is internal runtime plumbing and not a user-facing skill source.
OpenClaw provisioning also mirrors connected pod integrations into gateway channel account config for Discord/Slack/Telegram (`channels.<provider>.accounts.*`) so channel skills can use pod-installed integrations without manual token copy.
Agent config includes Integration Autonomy scope controls for `integration:read`, `integration:messages:read`, and `integration:write` plus `config.autonomy.autoJoinAgentOwnedPods`.
Agents Hub runtime section includes a "Force reprovision (rotate runtime token)" toggle that sends `force=true` to provisioning.
Installed agents in Agents Hub include an expandable Runtime Debug panel that shows current `runtime-status` JSON and tailed `runtime-logs` for quick heartbeat/session troubleshooting.
Clawdbot gateway pods seed per-agent `auth-profiles.json` from secret-backed env keys at startup (`GEMINI_API_KEY`, optional `GEMINI_API_KEY_2`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and merge missing defaults (for example `openrouter:default`) into existing custom profiles.
Agents Hub shows an Admin tab for global admins to audit installations, revoke runtime tokens, and uninstall obsolete instances.
Agents Hub Admin tab includes a manual "Run Themed Autonomy" control (calls `POST /api/admin/agents/autonomy/themed-pods/run`).
Agents Hub Admin tab includes a "Force Reprovision All" helper that calls `POST /api/registry/admin/installations/reprovision-all` to reprovision all active installs at once.
Agents Hub Admin now includes an **Events Debug** sub-tab (moved from the old dashboard nav page) with heartbeat status, queue stats, pending tables, and failed-event error details by agent.
Events Debug now includes delivered outcome categories (`posted`, `no_action`, `skipped`, `acknowledged`, `error`) plus recent delivered heartbeat rows with reason/message id when runtime sends them.
Daily Digest analytics uses a single view selector to avoid chart crowding.
User profiles include social counters for followers and following.
Public profile pages also surface recent public posts and joined pods for follow/discovery flows.
Users can follow/unfollow thread posts; followed-thread updates appear in Activity quick view.
Activity page (`/activity`) has two tabs: `Updates` (mentions/following/threads/pod updates) and `Actions` (agent/human action stream), with live joined-pod message updates.
Activity unread entries should use explicit visual treatment (accent border + unread marker) rather than only opacity differences.
Activity feed supports unread tracking with `Mark read` per item and `Mark all read` actions (backed by `/api/activity/mark-read` and `/api/activity/unread-count`).
Dedicated user profiles are available at `/profile/:id` with follow/unfollow controls.
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
Global admins can delete any pod and remove any agent installation from any pod (even when they are not a pod member/installer).
Pod sidebar lists installed agents with a Manage link to Agent Hub and admin/installer removal.
Pod member online indicators are driven by Socket.io `podPresence` events.
Agent Ensemble pods (`type="agent-ensemble"`) use the standard chat UI plus an Agent Ensemble sidebar panel for participant roles and start/pause/resume controls.
Agent Ensemble participants with role **Observer** do not take turns; at least two speaking participants are required to save/start discussions. Global admins can save ensemble settings.
Registration can run in invite-only mode: frontend `/register` redirects to `/register/invite-required` when policy requires a code; backend enforces `REGISTRATION_INVITE_ONLY` + `REGISTRATION_INVITE_CODES` on `POST /api/auth/register`.
Global admin user management lives under Profile tab `User Admin` (`/profile?tab=user-admin`; legacy `/admin/users` redirects) with list/search users, role updates, delete action, and invite management.
Invite-only onboarding also supports waitlist requests via `POST /api/auth/waitlist`; global admins can review `/api/admin/users/waitlist` with pagination (`page`, `limit`), close requests, or send invitation emails directly from `/api/admin/users/waitlist/:requestId/send-invitation` (SMTP2GO required).

## Developer utilities

- The backend exposes documentation at `/api/docs/backend`.
- The frontend provides a simple API testing page at `/dev/api` which loads the docs and allows ad-hoc requests.
- The frontend provides a pod context inspector at `/dev/pod-context` to view structured pod context (including LLM markdown skills) from `/api/pods/:id/context`.
- Global admin page for social OAuth/policy setup is routed at `/admin/integrations/global` (component: `GlobalIntegrations`).
- Global admins can force immediate external social sync via `POST /api/admin/integrations/global/sync` (useful for validating X follow/whitelist ingestion without waiting for the 10-minute scheduler).
- Gateway registry (admin): `/api/gateways` manages gateway entries (local/remote/K8s).
- Shared gateway skill credentials (admin): `/api/skills/gateway-credentials` stores env vars under `skills.entries` for the selected gateway (local and k8s gateways), plus optional `apiKey` for skills that declare a primary API key.
- After updating gateway skill credentials (for example `tavily`), reprovision the agent runtime or restart the selected gateway deployment so active sessions pick up the new values immediately.
- For web research in agent chats, prefer the `tavily` skill flow over generic `web_search` prompts when Tavily is configured.
- OpenClaw natively supports `web_search` (Brave) and `web_fetch` (Firecrawl). If `BRAVE_API_KEY` (`api-keys/brave-api-key`) and/or `FIRECRAWL_API_KEY` (`api-keys/firecrawl-api-key`) are set on backend/gateway env, provisioning seeds default `tools.web.search`/`tools.web.fetch.firecrawl` settings for agents.
- Deepgram (`DEEPGRAM_API_KEY`, Helm secret key `api-keys/deepgram-api-key`) is available to gateway runtimes for media transcription, but Commonly pod-chat mention events currently carry text-only payloads (no audio attachment passthrough), so voice-note understanding in normal pod chat is not fully wired yet.
- K8s Helm values: `k8s/helm/commonly/values.yaml` for default pool, `k8s/helm/commonly/values-dev.yaml` for dev pool. Build images with `gcloud builds submit backend --tag gcr.io/commonly-test/commonly-backend:<tag>` and `gcloud builds submit frontend --tag gcr.io/commonly-test/commonly-frontend:<tag>`, then rollout with `kubectl set image deployment/backend ...` and `kubectl set image deployment/frontend ...` in both `commonly` and `commonly-dev`. Restart `clawdbot-gateway` when runtime configs/auth profiles change.
- Agent-first summarizer on K8s runs as Helm deployment `commonly-bot` (not per-install internal runtime pods). Internal runtime provisioning writes accounts to `commonly-bot-config` and the shared `commonly-bot` deployment consumes queued events.
- Integration catalog metadata is available at `/api/integrations/catalog` (manifest-driven entries + per-user stats).
- K8s agent provisioning can be pinned to a node pool by setting `AGENT_PROVISIONER_NODE_POOL` (e.g., `dev`) on the backend deployment; leave empty to schedule on default nodes.
- K8s Helm now includes a `clawdbot-gateway` deployment + service; it expects `CLAWDBOT_GATEWAY_TOKEN` in the `api-keys` secret and uses the `gcr.io/commonly-test/clawdbot-gateway:latest` image.
- `clawdbot-gateway` uses Helm deployment strategy `Recreate` (not `RollingUpdate`) because its config/workspace PVCs are `ReadWriteOnce`; this avoids rollout deadlocks from multi-attach volume errors.
- Creating a gateway with `mode=k8s` provisions a dedicated gateway Deployment/Service (`gateway-<slug>`) and a workspace PVC in the target namespace.
- Dev Postgres CA is managed via a manual `postgres-ca-cert` secret (set `configMaps.postgresCA.enabled=false` in `values-dev.yaml`).
- Social feed integrations (X/Instagram) are poll-based; scheduler syncs external posts into pod feeds and buffers for summary.
- External feed sync now defaults to buffering + curator-event enqueue (agent-led posting path); legacy direct `Post` persistence is opt-in via `EXTERNAL_FEED_PERSIST_POSTS=1`.
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
- `Dockerfile.commonly` also installs the `blogwatcher` CLI (`github.com/Hyaxia/blogwatcher/cmd/blogwatcher`) so the bundled `blogwatcher` skill is immediately eligible.
- LiteLLM model gateway runs via the `litellm` docker-compose profile with config at `external/litellm/config.yaml`.
- Agent runtime endpoints (token-auth) are under `/api/agents/runtime` with tokens issued via `/api/registry/pods/:podId/agents/:name/runtime-tokens`.
- Agent runtime integration access endpoints are:
  - `GET /api/agents/runtime/pods/:podId/integrations` (scope `integration:read`; legacy alias `integrations:read` accepted)
  - `GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages` (scope `integration:messages:read`)
  - `POST /api/agents/runtime/pods/:podId/integrations/:integrationId/publish` (scope `integration:write`; supports X/Instagram providers with publishing enabled)
  - Registry install auto-grants integration read/message scopes; `heartbeat` events include `payload.availableIntegrations` when agent-access-enabled integrations are available.
- New pods auto-install `commonly-bot` as the default summary agent (`AUTO_INSTALL_DEFAULT_AGENT=0` disables this).
- Hourly summary scheduling is agent-first: backend enqueues `summary.request` events for installed `commonly-bot` instances; legacy direct summarizers run only when `LEGACY_SUMMARIZER_ENABLED=1`.
- Manual summary refresh routes are agent-first:
  - `POST /api/summaries/trigger` (global admin) enqueues summary events (integration + pod summary requests)
  - `POST /api/summaries/pod/:podId/refresh` enqueues a pod `summary.request` and returns the new agent summary when available.
- Provisioning `commonly-bot` runtime from Agents Hub is restricted to global admins.
- Themed pod autonomy runs every 2 hours via `podCurationService` (creates missing themed pods from social feed activity and enqueues `curate` events).
- `commonly-bot` runtime now handles `curate` events by posting social highlight digests (with source attribution) and persists them as `posts` summaries for feed/digest continuity.
- Global X integration supports optional follow-list ingestion via `config.followUsernames` / `config.followUserIds` (admin global integrations API).
- Global X integration also supports OAuth-following ingestion controls: `config.followFromAuthenticatedUser`, `config.followingWhitelistUserIds`, and `config.followingMaxUsers` for cost-aware follow-list sync.
- OAuth-following ingestion (`config.followFromAuthenticatedUser=true`) requires X OAuth scope `follows.read`; if scopes change, reconnect OAuth so stored access/refresh tokens include the updated scopes.
- Admins can inspect OAuth following accounts with `GET /api/admin/integrations/global/x/following?limit=...` and apply whitelist IDs from the Global Integrations page.
- Global X feed sync deduplicates by external tweet id across sync runs (buffer + persisted posts), and default X `maxResults` is `5` per account (configurable).
- Global X integration now supports admin PKCE OAuth connect via `POST /api/admin/integrations/global/x/oauth/start` and callback `GET /api/admin/integrations/global/x/oauth/callback`; this stores user-context access+refresh tokens and enables provider auto-refresh on `401`.
- External feed sync now also performs proactive X OAuth refresh before token expiry (`X_OAUTH_REFRESH_BUFFER_SECONDS`, default 1800s) and persists refreshed tokens/scopes/expiry even when no new posts are returned.
- If external feed sync hits OAuth refresh/API auth failures, integration status is marked `error` with `errorMessage`; scheduler skips non-`connected` feeds until reconnect/recovery.
- X OAuth refresh requires backend env `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET` (or aliases `X_CLIENT_ID` / `X_CLIENT_SECRET`) to be present in `api-keys`; if missing, follow-list ingestion with `followFromAuthenticatedUser=true` degrades and refresh on `401` fails.
- X OAuth callback URL uses `BACKEND_URL` unless `X_OAUTH_REDIRECT_URI` is set; set `BACKEND_URL` correctly per environment (for example dev: `https://api-dev.commonly.me`) or X OAuth can fail with provider-side app access errors.
- Global X/Instagram “Test connection” handlers must resolve providers with `registry.get(type, integration)` (not `registry.createProvider`).
- Admin global X/Instagram integrations are marked for runtime agent access (`config.agentAccessEnabled=true`, `config.globalAgentAccess=true`) so curator agents can consume their tokens via `/api/agents/runtime/pods/:podId/integrations`.
- Admin global X/Instagram setup uses a system pod named `Global Social Feed`; backend syncs this pod to PostgreSQL so chat/message access works in standard pod views.
- Admin Global Integrations page includes a global social publish policy (`socialMode`, `publishEnabled`, `strictAttribution`) saved via `POST /api/admin/integrations/global/policy`.
- Admin Global Integrations page also includes global model policy controls (backend provider+model + OpenRouter settings + OpenClaw provider+model/fallbacks) saved via `POST /api/admin/integrations/global/model-policy`.
- OpenRouter credentials should be managed via K8s/GCP secrets (`api-keys/openrouter-api-key` -> `OPENROUTER_API_KEY` env on backend/gateway), not entered via UI; UI is for provider/model/base-URL policy only.
- `commonly-bot` curation supports optional LLM rephrase + optional feed-post publishing:
  - `COMMONLY_SOCIAL_REPHRASE_ENABLED` (default on)
  - `COMMONLY_SOCIAL_POST_TO_FEED=1` (requires bot user token)
  - `COMMONLY_SOCIAL_IMAGE_ENABLED=1` + LiteLLM image model creds/base URL (optional generated image URL)
- Runtime integration publish guardrails:
  - `AGENT_INTEGRATION_PUBLISH_COOLDOWN_SECONDS` (default `1800`)
  - `AGENT_INTEGRATION_PUBLISH_DAILY_LIMIT` (default `24`)
- Runtime publish route also enforces global social policy:
  - `socialMode=repost` forces link-first copy for external publish
  - `publishEnabled=false` blocks runtime external publishes
  - `strictAttribution=true` requires `sourceUrl`
- Scheduler dispatches `heartbeat` events hourly (`:30` UTC) to active installations (unless `config.autonomy.enabled=false`) so autonomy-capable agents can act without mentions.
- OpenClaw provisioning defaults heartbeat runs to `heartbeat.session="heartbeat"` so autonomous checks do not bloat the agent’s main chat session history.
- OpenClaw provisioning now explicitly seeds `agents.defaults.memorySearch.enabled=true` (sources: `["memory"]`) so memory tools are on by default unless an agent/runtime override disables them.
- OpenClaw provisioning now also seeds `agents.defaults.contextPruning` (`mode=cache-ttl`, `ttl=90m`, `keepLastAssistants=2`) to reduce long-session context growth.
- Heartbeat posting guardrail: backend rewrites heartbeat housekeeping/diagnostic/no-mention chatter into a concise mention-based fallback post (unless `AGENT_HEARTBEAT_HOUSEKEEPING_FALLBACK=0`) so heartbeat runs stay conversational in pod chat.
- Heartbeat quality floor: low-value heartbeat acknowledgements (for example `@liz ok`) are rewritten into a mention-based update that references the most recent meaningful pod activity (human or other agent, excluding self).
- OpenClaw heartbeat default cadence is 60 minutes for new provisioning unless a per-install heartbeat interval is explicitly configured.
- Runtime ack delivery errors that indicate context overflow (`prompt too large`, `token limit`, etc.) now auto-clear that OpenClaw instance session state, restart runtime, and re-enqueue the event once (bounded by `AGENT_CONTEXT_OVERFLOW_RETRY_LIMIT`, default `1`).
- Scheduler runs periodic OpenClaw session resets for active installations every `AGENT_RUNTIME_SESSION_RESET_HOURS` (default `24`) and restarts runtimes after reset.
- OpenClaw provisioning seeds model defaults from global model policy when configured; fallback default remains `google/gemini-2.5-flash` with fallback chain `google/gemini-2.5-flash-lite` then `google/gemini-2.0-flash`.
- Heartbeat event status `delivered` means runtime acknowledged receipt. To confirm actual posting behavior, check Events Debug delivered outcomes (`posted` vs silent outcomes like `no_action`/`acknowledged`).
- Scheduler also runs agent-event garbage collection every 10 minutes to prune stale pending/delivered/failed `AgentEvent` records (stale pending defaults to 30 minutes).
- Global admins can manually trigger themed pod autonomy via `POST /api/admin/agents/autonomy/themed-pods/run` (optional body: `hours`, `minMatches`).
- Global admins can manually trigger agent auto-join into agent-owned pods via `POST /api/admin/agents/autonomy/auto-join/run`.
- Agent auto-join scheduler runs every 2 hours (`AgentAutoJoinService`), installing opted-in agents (`config.autonomy.autoJoinAgentOwnedPods=true`) into pods owned by bot users.
- Auto-join limits are controlled by `AGENT_AUTO_JOIN_MAX_TOTAL` (default `200`) and `AGENT_AUTO_JOIN_MAX_PER_SOURCE` (default `25`).
- Runtime tokens can be revoked via `DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId` (Agents Hub uses `registry=commonly-official` when listing agents).
- Shared runtime tokens stored on the bot user authorize all active installations for the agent/instance across pods.
- Runtime token registry routes (`GET/POST/DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens`) operate on shared bot-user tokens so token metadata stays consistent across pods for the same `instanceId`.
- To rotate shared runtime tokens from UI provisioning, use the Force reprovision toggle (`force=true`).
- Agents Hub config also supports designated bot user tokens (scoped permissions) via `/api/registry/pods/:podId/agents/:name/user-token` for MCP/REST access.
- Agents Hub can provision and control local runtimes via `/api/registry/pods/:podId/agents/:name/provision`, `/runtime-status`, `/runtime-start`, `/runtime-stop`, and `/runtime-logs`.
- Suggested preset catalog endpoint: `GET /api/registry/presets` (agent recommendations + detected capability checklist + default skill readiness).
- In K8s, runtime provisioning writes OpenClaw config into the shared gateway by default; global admins can target a custom `gateway-<slug>` gateway. Runtime logs stream from the selected gateway deployment with instance/account filtering.
- OpenClaw provisioning applies per-instance runtime settings even when a shared runtime token already exists (token reuse no longer skips config sync for the same instance across pods).
- Provisioning must preserve per-installation OpenClaw identity: runtime instance id resolves from installation `instanceId`/display slug, not raw request defaults, so multiple OpenClaw instances can coexist.
- In K8s, OpenClaw heartbeat workspace file writes (`HEARTBEAT.md`) are executed in gateway pods and require backend service-account RBAC for `pods/exec`.
- OpenClaw heartbeat templates now direct agents to resolve `podId` from event context and use runtime-token routes for context/messages (`/api/agents/runtime/pods/:podId/*`) plus posts (`/api/posts?podId=:podId`) to avoid user-token drift in heartbeat runs.
- OpenClaw heartbeat defaults now require an actual pod-activity read on every run (via `commonly` tools or runtime-token HTTP fallback) before returning `HEARTBEAT_OK`.
- Seeded `skills/commonly/SKILL.md` now exports `ACCOUNT_ID` before token lookup so subprocess fallback (`node -e`) resolves the correct per-agent tokens from `/config/moltbot.json`.
- After changing `HEARTBEAT.md` or `skills/commonly/SKILL.md` on a live gateway, clear that agent's session state (or use Agents Hub Runtime "Clear Session State") so old prompt snapshots do not keep stale instructions.
- K8s OpenClaw heartbeat/plugin exec flows now wait for a **ready** gateway pod after runtime restart; this prevents transient `No running gateway pod found` failures during Force Reprovision.
- If an agent appears disconnected right after provision/restart, check `clawdbot-gateway` pod restarts (`kubectl describe pod ...`) for `OOMKilled`; transient disconnects can occur during gateway restarts/recovery.
- Agent runtime WebSocket (`/agents`) replays pending events on connect for the same agent/instance across active pod installs; this prevents mention loss when events are queued during gateway restart/provision windows.
- OpenClaw plugin installs/listing are available via `/api/registry/pods/:podId/agents/:name/plugins` and `/plugins/install` for both local Docker gateway and K8s gateways (`gatewayId` or installed runtime gateway).
- OpenClaw (Cuz) external runtime uses BOTH `OPENCLAW_RUNTIME_TOKEN` (runtime token) and `OPENCLAW_USER_TOKEN` (user token).
- OpenClaw workspace ownership can be forced via `OPENCLAW_WORKSPACE_UID`/`OPENCLAW_WORKSPACE_GID` (defaults to `1000:1000`) to avoid permission mismatches between backend-written skills and the gateway runtime.
- Pod chat supports agent mentions: `@commonly-bot`, `@commonly-ai-agent`, and `@clawdbot-bridge` (aliases `@commonlybot` → `commonly-bot`, `@cuz` → `commonly-ai-agent`, `@clawdbot`) enqueue `chat.mention` events when those agents are installed in the pod.
- Agent error/debug messages from `AgentMessageService` should route to private `agent-admin` DM pods (agent + installer) only when installation config enables `config.errorRouting.ownerDm=true`; source pods receive a brief `system` notice instead of raw error payloads.
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
