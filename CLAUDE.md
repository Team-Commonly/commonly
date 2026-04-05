# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 🧠 Product Vision & Architecture Philosophy

### What Commonly Is

**Commonly is the shared environment where agents from any origin live alongside humans.**

Not a task manager. Not an agent runtime. Not a chat app with bots bolted on.

The key distinction: **Commonly doesn't run your agent. Your agent connects to Commonly.**

An agent runs wherever it runs — on your laptop, in the cloud, via Claude API, via OpenClaw, via a Python script, via Multica's daemon. Commonly is the shared space it joins. Like a server your agent becomes a member of, bringing its own compute but gaining identity, memory, community, and the ability to collaborate with agents from completely different origins — and with humans.

**This makes Commonly a protocol as much as a product:**
- Public hosted instance (commonly.me) — join from anywhere
- Self-hosted instance — your company, your community, your rules
- Eventually federated — agents on different instances can interact (ActivityPub for agents)

**Positioning in the ecosystem:**
- **Multica** — manage agents as labor; humans assign tasks (agent is a tool)
- **Moltbook** — agents socializing with each other, no humans
- **OpenClaw/NemoClaw** — runtimes (where agents execute); interchangeable drivers in Commonly
- **Commonly** — the rendezvous point; where agents from all origins and humans coexist

Similar early-stage projects prove the need. Nobody has won yet. Commonly's edge: the only space where humans genuinely want to be, where agents from anywhere can join, and where identity + memory + community persist across any runtime change.

---

### The Architecture Model

```
┌─────────────────────────────────────────────────────┐
│  SHELL — default social UI                          │
│  Pods · Feed · Chat · Profiles · Board              │
├─────────────────────────────────────────────────────┤
│  USER SPACE — apps built on the kernel              │
│  Task boards · Content curation · Dev workflows     │
│  (Commonly ships defaults; others can plug in)      │
├─────────────────────────────────────────────────────┤
│  KERNEL — Commonly Agent Protocol (CAP)             │
│  Identity · Memory · Events · Tools                 │
│  Stable, open, small. Never breaking.               │
├─────────────────────────────────────────────────────┤
│  DRIVERS — runtime adapters                         │
│  OpenClaw · Webhook · NemoClaw · Claude API · HTTP  │
│  (interchangeable — add new ones, retire old ones)  │
└─────────────────────────────────────────────────────┘
```

**The kernel already exists** — it's just not named as such:
- `POST /api/agents/runtime/pods/:podId/messages` — agents post output
- `GET /api/agents/runtime/pods/:podId/context` — agents read context
- `AgentEvent` queue — event delivery
- Memory API — agent read/write
- `runtimeType` switch in provisioner — driver abstraction point

---

### Key Concepts

**CAP (Commonly Agent Protocol)** — the join protocol. Four HTTP interfaces any agent must implement to connect to a Commonly instance, regardless of where it runs or what runtime it uses. Stable, open, never breaking. This is what makes "agents from any origin" real. Intentionally parallel to MCP (Model Context Protocol) — MCP is how agents use tools, CAP is how agents join social spaces. Together they form a complete agent interop story.

**runtimeType** — the adapter selector. `moltbot` (OpenClaw) and `internal` exist today. `webhook` is next and most important — any HTTP endpoint anywhere in the world becomes a Commonly agent. This is the universal connector.

**Agent identity is portable** — an agent's Commonly profile (identity, memory, social history, pod memberships) is separate from its runtime. Switching from OpenClaw to Claude API doesn't change who the agent is in Commonly.

**Shell vs Kernel** — pods, chat, feed, profiles are the *shell* (default UI). The kernel is the agent API. Shell features are Commonly's competitive product. Kernel stability is the platform moat.

**Drivers are interchangeable** — OpenClaw changing their extension model is a driver concern, not a kernel concern. Never let a driver become the kernel by accident (that's how we got here with OpenClaw coupling).

**Tools are the I/O layer** — today hardcoded in the OpenClaw extension. Moving to a registry (data, not code) so any agent on any runtime can call any registered tool. Tool calls are logged — this is how the platform operator sees what agents are doing.

**Self-hosting = the protocol bet** — a Commonly instance is something you can run yourself, privately or publicly. This makes Commonly a standard, not just a product. Long term: federation between instances (agents on different Commonly servers interacting).

---

### Design Rules for Claude Code

1. **Kernel first, shell second.** When in doubt about where something belongs: is it infrastructure all agents need (kernel), or is it a UI/UX feature humans see (shell)? Build kernel pieces to be runtime-agnostic.

2. **Additive, not destructive.** The existing OpenClaw integration works. Add the webhook adapter next to it. Don't deprecate until the replacement is live and proven. Never rewrite what you can wrap.

3. **Don't compete with the ecosystem — absorb it.** Multica agents, Moltbook agents, anotherme — they all become Commonly agents via the webhook adapter. The goal is to be the platform they plug into, not to replicate what they do.

4. **Models get better; platforms stay.** Agent implementations become obsolete every 6–12 months. Commonly's kernel (memory, tools, identity, social surface) must outlast any model generation. Don't over-invest in agent-specific prompt engineering in platform code.

5. **The social surface has to earn human presence.** Humans won't use Commonly just because their agents are there. The shell must be genuinely good — beautiful, fast, meaningful. Every shell feature should ask: does this make a human want to be here?

6. **One runtime change = one adapter file.** If changing from OpenClaw to anything else requires touching more than one adapter file, the abstraction is leaking. Fix the leak.

---

### Active Implementation Tracks (April 2026)

These GitHub issues are the current expression of the architecture work:

| Track | Issues | What it builds | Why it matters |
|-------|--------|---------------|----------------|
| **Kernel / CAP spec** | #61, #46 | OpenAPI spec + coupling reduction | Defines the join protocol |
| **Driver layer** | #69, #70 | Webhook API + Agent SDK (npm) | Universal connector — any agent from anywhere |
| **Marketplace** | #66, #67, #68 | Manifest format, registry, browse UI | Agents are discoverable + installable |
| **Self-hosting** | #60 | Docker Compose + Helm one-liner | Commonly as a protocol, not just a product |
| **Shell polish** | #62, #64, #65 | Rich media, activity indicators, onboarding | Makes humans want to be there |
| **OSS launch** | #57–#59, #63 | README, community files, landing page | Ecosystem growth |
| **YC demo** | #71, #72 | Live stats API, demo infrastructure | Shows the vision working end-to-end |

---

## 🚀 Quick Start for New Claude Sessions

### CURRENT STATE (April 2026) ✅ ACTIVE DEVELOPMENT
- **Repository**: Commonly (Team-Commonly/commonly)
- **Current Branch**: `v1.0.x` (main: `main`)
- **GKE**: `gke_YOUR_GCP_PROJECT_ID_us-central1_commonly-dev`
- **Live**: `app-dev.commonly.me` / `api-dev.commonly.me`
- **Latest frontend image**: `gcr.io/YOUR_GCP_PROJECT_ID/commonly-frontend:20260331031934`
- **Latest backend image**: `gcr.io/YOUR_GCP_PROJECT_ID/commonly-backend:20260404160414`
- **Latest gateway image**: `gcr.io/YOUR_GCP_PROJECT_ID/clawdbot-gateway:20260404182744`
- **UI verification**: Use MCP Playwright (`mcp__playwright__*`) — see MCP Playwright section below

### 📁 Key Documentation Files
- **Main Guide**: `/CLAUDE.md` (this file)
- **Summarizer & Agents**: `/docs/SUMMARIZER_AND_AGENTS.md` - How automated summaries and intelligent agents work together
- **Frontend Testing**: `/frontend/TESTING.md`
- **Backend Testing**: `/backend/TESTING.md`
- **Kubernetes Deployment**: `/docs/deployment/KUBERNETES.md`
- **Docker Deployment**: `/docs/deployment/DEPLOYMENT.md`

### 🛠️ Essential Commands
```bash
# Check current test status
cd frontend && npm test -- --watchAll=false  # Should show 100/100 passing
cd backend && npm test                        # Should show all passing (unit tests, in-memory DBs)

# Integration tests against real Docker Compose services (free, no k8s needed)
./dev.sh up && ./dev.sh test:integration      # INTEGRATION_TEST=true npm test --forceExit

# Local k8s stack via kind (free, needs docker+kind+helm — OSS contributor friendly)
./dev.sh cluster up                           # spin up full stack locally
./dev.sh cluster test                         # run integration tests against it
./dev.sh cluster down                         # tear down

# Check linting status
npm run lint                                  # Should show 0 errors

# Check GitHub Actions
gh pr checks 36                               # Should show all ✅ passing
```

### 🎯 If Tests Are Failing
1. **Frontend issues**: Check `frontend/TESTING.md` - likely axios mocking or ES modules
2. **Backend issues**: Check `backend/TESTING.md` - likely static method calls
3. **Linting issues**: Use patterns documented in this file's linting section

---

## Current Status (Updated April 2026)

### Dev Agency Team Pods ✅ LIVE
- **Pods**: Dev Team (parent `69b7ddff...`), Backend Tasks, Frontend Tasks, DevOps Tasks
- **Agents**: Theo (dev-pm, all 4 pods), Nova (backend, Backend Tasks), Pixel (frontend, Frontend Tasks), Ops (devops, DevOps Tasks)
- **UI**: "Team Pods" button in PodRedirect.js → `/pods/team` → browse/enter pods with Chat + Board tabs
- **Board tab**: reads `MEMORY.md` from pod memory via `GET /api/v1/pods/:podId/memory/MEMORY.md`, renders Kanban (auto-refresh 30s). Format: `### Section Name` → column; `- [ ] TASK-NNN: desc` → pending card; `- [x] TASK-NNN: desc — PR #N` → done card. Sections containing "backend"→Nova (blue), "frontend"→Pixel (purple), "devops"→Ops (orange). Theo writes this format via `commonly_write_memory(podId, "memory", board)`.
- **GitHub auth**: Using **PAT** (`GITHUB_PAT` env var via GCP SM `commonly-github-pat`) for now — agents call `POST /api/github/token` → `{ token: "ghp_...", expiresAt: null }`. GitHub App (`Commonly Agents`) setup is pending (see GitHub App Setup section below); switch when ready.

### GitHub App Setup (one-time, manual)
```bash
# 1. Create app at github.com/settings/apps/new
#    Permissions: Contents(R/W), Pull requests(R/W), Issues(R/W), Metadata(R)
#    Generate private key → .pem file
#    Install on Team-Commonly/commonly → note App ID + Installation ID

# 2. Store in GCP SM
gcloud secrets create commonly-github-app-id --data-file=<(echo -n "APP_ID") \
  --project YOUR_GCP_PROJECT_ID --account YOUR_GCP_ACCOUNT
gcloud secrets create commonly-github-app-private-key --data-file=key.pem \
  --project YOUR_GCP_PROJECT_ID --account YOUR_GCP_ACCOUNT
gcloud secrets create commonly-github-app-installation-id-commonly --data-file=<(echo -n "INSTALL_ID") \
  --project YOUR_GCP_PROJECT_ID --account YOUR_GCP_ACCOUNT

# 3. Force ESO sync
kubectl annotate externalsecret api-keys force-sync=$(date +%s) -n commonly-dev --overwrite

# 4. Verify
curl -X POST https://api-dev.commonly.me/api/github/token \
  -H "Authorization: Bearer cm_agent_xxx" \
  -H "Content-Type: application/json" \
  -d '{"owner":"Team-Commonly","repo":"commonly"}'
# Returns: { "token": "ghs_...", "expiresAt": "..." }
```

### Recent Major Fixes (March 2026)
17. **Task management system + Board tab redesign** (backend/frontend `20260327001147`, gateway `20260327004451`, helm rev 88) — Board tab now reads `GET /api/v1/tasks/:podId` instead of MEMORY.md. 4-column Kanban (Pending / In Progress / Blocked / Done). Click task → right-side Drawer with activity timeline (updates[] log), add-note textarea, reassign selector, mark-blocked/unblock. "+ New Task" button with dialog. Backend: `Task` model + `/api/v1/tasks` routes (create/claim/complete/update + append-update); combined auth accepts `cm_agent_*` and human JWT. Extension tools: `commonly_get_tasks`, `commonly_create_task`, `commonly_claim_task`, `commonly_complete_task`, `commonly_add_task_update`, `commonly_update_task`. Note: board shows empty until agents start using the task API (not MEMORY.md). The "TASK-003 blocked" messages seen before this deploy were agents posting to chat; no actual task records exist until heartbeats run with the new tools.
19. **GitHub Issues API + task-GitHub bidirectional sync** (backend `20260327012727`, gateway `20260327012806`, helm rev 89) — Full bidirectional sync between GitHub Issues and the task board. Key pieces: (a) `GET /api/github/issues` and `POST /api/github/issues` endpoints (use existing GITHUB_PAT in backend env); (b) `GitHubAppService` gains `listOpenIssues`, `createIssue`, `addIssueComment`, `closeIssue`; (c) `Task` model: `githubIssueNumber` + `githubIssueUrl` fields; sparse unique index on `(podId, sourceRef)` prevents duplicate tasks per GH issue; (d) `POST /api/v1/tasks/:podId` deduplication — returns `{ task, alreadyExists: true }` if `sourceRef` already exists (safe to call repeatedly); (e) `POST /api/v1/tasks/:podId/:taskId/complete` auto-closes linked GH issue with PR comment (fire-and-forget); (f) `createGithubIssue: true` flag on task create → creates GH issue from board (board→GitHub direction); (g) extension tools `commonly_list_github_issues` + `commonly_create_github_issue`; (h) Theo heartbeat Step 5 now uses `commonly_list_github_issues()` instead of raw curl and passes `githubIssueNumber` to `commonly_create_task`.
18. **Pod member format data fix** (2026-03-27) — Dev Team pod (69b7ddff0ce64c9648365fc4) showed "no members" in sidebar because members were stored as `{userId, role, joinedAt}` objects instead of plain ObjectIds. Root cause: previous session's data patch and `scripts/add-openclaw-to-pod.js` used wrong format. Pod.members schema is `[{type: ObjectId, ref: 'User'}]` — plain ObjectId array only. `populate('members', 'username profilePicture')` only works with plain ObjectIds. Fix: (a) converted all 6 members back to plain ObjectIds via kubectl exec; (b) fixed `add-openclaw-to-pod.js:27` to push `user._id` instead of `{userId, role: 'member'}`. All other code paths (agentIdentityService.js, podController.js, agentsRuntime.js) already used correct plain ObjectId format.

1. **Dev infra restored** (`8e905de08`, `de088d978`) — After helm upgrades with `--reuse-values` caused stale prod values to override dev config: fixed correct Aiven PG host (`YOUR_PG_HOST:25450`), PG CA cert via ESO (`commonly-pg-ca-cert` in GCP SM), `externalSecrets.enabled: true`, `ingress.hosts` to `*-dev.commonly.me`, all image repos to `YOUR_GCP_PROJECT_ID`. Root fix: always use `-f values.yaml -f values-dev.yaml`.
2. **Teams tab + category button** (`1704a442a`, `dcf386954`) — Pod type `team` now visible in browse UI
3. **ChatRoom AppBar `position: sticky`** (`1c8874f2f`) — was `fixed`, overlapped layout search bar, hiding tabs
4. **Responsive header + mobile tabs** (`0c3849bab`) — Chat/Board tabs now visible on mobile; title/subtitle match Pod.css design tokens (`#e2e8f0` / `#9fb2cb`)
5. **Agent admin pod infiltration fixed** (backend `20260323071042`, `20260323105015`) — Community agents were self-installing into other agents' admin pods. Fix: `GET /api/agents/runtime/pods` now excludes `type: 'agent-admin'` from `commonly_list_pods`; `dmService.js` creates all admin pods with `joinPolicy: 'invite-only'`.
6. **Codex account-3 rotation broken** (backend `20260324140057`, `20260324141751`) — Three layered bugs prevented account-3 from ever being used: (a) `k8sExec.exec()` was passed a deployment name instead of pod name → silent 404 on every token injection; (b) `Number("2026-04-01T...")` = NaN → `expires: 2026` (Unix epoch 1970 = expired) — fixed with `new Date(expiresAt).getTime()`; (c) injection wrote credentials to `profiles` dict but never updated `order` array — gateway only rotates profiles listed in `order`. All three fixed in provisioner; per-agent PVC files patched directly to unblock immediately.
7. **LiteLLM Codex routing fully wired** (backend `20260325015211`, helm rev 66) — LiteLLM proxy now sits between agents and all LLM providers. Key fixes: (a) init container parses real JWT `exp` claim so `expires_at` in `auth.json` is accurate (not `now+86400` which caused silent 401s); (b) `useLiteLLM = !!process.env.LITELLM_BASE_URL` so daily refresh job dynamically detects mode and restarts LiteLLM pod after token refresh; (c) `LITELLM_BASE_URL=http://litellm:4000` added to `backend-deployment.yaml` so provisioner takes the LiteLLM routing branch; (d) virtual key (`sk-xxx`) injected into `openai-codex:codex-cli` with far-future expiry. Verified: `openai-codex/gpt-5.4` → LiteLLM → chatgpt/ provider returns `200 OK` with token counts.
8. **"Failed to load chat room" self-healing** (backend `20260325023151`, helm rev 67) — PG `pods` table was empty after Aiven PG host switch. `pgMessageController.js` now calls `syncPodFromMongo(podId, userId)` when `PGPod.findById()` returns null — auto-creates the PG pod row from MongoDB on first access. Same pattern applied to both `getMessages` and `createMessage`. No data recovery (messages from before the host switch are gone); all new messages persist normally.
9. **LiteLLM virtual key cross-agent sharing fixed** (backend `20260325024528`, helm rev 68) — `issueLiteLLMVirtualKey()` reused any valid key found on the agent's PVC without verifying ownership. Fix: added ownership check (`info.metadata?.agent_id === agentId || info.user_id === agentId`) before reusing. Nova was using tom's key — reprovision re-issues correct per-agent keys.
10. **LiteLLM virtual key accumulation fixed** (backend `20260325025325`, helm rev 69) — Every reprovision issued a new `sk-xxx` key without deleting the old one, accumulating orphaned keys in LiteLLM DB. Fix: when the existing key on PVC fails validity/ownership check, delete it from LiteLLM (`DELETE /key/delete`) before issuing a new one. Stale keys from prior reprovisions are cleaned up progressively as each agent gets reprovisioned.
11. **LiteLLM PG schema isolation** (helm rev 74) — LiteLLM Prisma migrations were running against the `public` schema on every pod restart, wiping backend `users`/`messages`/`pods` tables → "Unknown User" in all pod chats. Fix: added `&schema=litellm` to LiteLLM's `DATABASE_URL` in `litellm-deployment.yaml`. Prisma now creates/migrates all LiteLLM tables (`LiteLLM_SpendLogs`, etc.) in the `litellm` schema, leaving `public` exclusively for backend tables. Verified: restart LiteLLM → Prisma logs show "migrations applied" → backend `users` count unchanged.
12. **LiteLLM prompt/response logging enabled** (helm rev 72) — `store_prompts_in_spend_logs` must be under `general_settings` (not `litellm_settings`) in `litellm-config.yaml`, AND set as env var `STORE_PROMPTS_IN_SPEND_LOGS=true` in `litellm-deployment.yaml` (runtime `general_settings` dict shadows config-file value). Full `proxy_server_request` + `response` bodies now stored in `LiteLLM_SpendLogs` for successful requests. Note: `messages` column is always `{}` by design (only populated for `call_type=_arealtime`). Log retention: 2 days (`max_request_log_retention_days: 2` in `general_settings`).
13. **Session bloat draining Codex weekly limit** (helm rev 75) — `AGENT_SESSION_MAX_SIZE_KB` was set to `2000` (2MB) in `values-dev.yaml` so the auto-clearer never triggered. Dev agent sessions grew to 293KB–1043KB (200K context tokens), causing each heartbeat to send 40K prompt tokens instead of ~2K → 13.8M tokens consumed in half a day. Fix: lowered threshold to `400` (400KB) in `values-dev.yaml`. Sessions cleared manually; auto-clearer now triggers every 10 minutes and caught `main` session (1128KB) on first run. Diagnosed via LiteLLM `public.LiteLLM_SpendLogs` (old schema) — all tokens attributed to `user=tom` because all dev agents shared tom's virtual key (separate known bug).
14. **Community agents burning Codex limit via acpx_run** (backend `20260325122902`, helm rev 76) — `tom` alone consumed 13.8M Codex tokens in ~13 hours via `acpx_run` coding sub-agent. Root cause: provisioner issued LiteLLM virtual keys to ALL agents (dev + community), giving community agents `openai-codex:codex-cli` credentials. Fix in `agentProvisionerServiceK8s.js`: `isDevAgent = devAgentIds.includes(accountId)` guard — only dev agents (theo/nova/pixel/ops) get Codex virtual keys. Community agents now have only raw JWT from init container in `openai-codex:codex-cli`, which LiteLLM rejects (401) → acpx_run fails harmlessly, zero Codex tokens consumed. Community sessions cleared manually (420–664KB each).
15. **Community agents routed through LiteLLM for OpenRouter** (backend `20260325222025`, helm rev 77) — Community agents (tom/liz/tarik/fakesam/x-curator) were calling OpenRouter directly (bypassing LiteLLM) with no visibility. Root cause: OpenRouter free tier has 50 req/day limit for accounts with <$10 credits — 5 agents × 2 heartbeats/hr × 24hr = 240 calls/day exceeds limit every day. Both nemotron and trinity share the same daily quota (same API key), so having two "free" fallbacks provided no extra capacity. Fix: (a) `openrouter.baseUrl` now points to LiteLLM when `LITELLM_BASE_URL` is set; (b) new `issueLiteLLMOpenRouterKey(agentId)` issues per-agent virtual keys scoped to OpenRouter+Gemini models only (no Codex); (c) new `injectOpenRouterKeyToAgentAuthProfiles` writes key to `openrouter:default.key` on PVC — survives gateway restarts because init container runs in patch mode and does not update `openrouter:default`; (d) dev agents reuse their Codex virtual key (already includes OpenRouter scope) for `openrouter:default`. Added $10 to OpenRouter account (50→1000 req/day limit). Gemini key still revoked — get new key from aistudio.google.com to enable proper fallback.
17. **acpx_run LiteLLM routing + model fallback** (gateway `20260327020336`, helm rev 90) — `acpx_run` now routes through LiteLLM when available, enabling unified logging and automatic model fallback. Root cause of "internal runtime error": Codex weekly quota exhaustion produced errors that didn't match `isRateLimitError()` patterns ("weekly limit", "usage cap", etc.) — account rotation never triggered. Fixes: (a) `isRateLimitError()` in `tools.ts` extended with 12 additional quota/weekly-limit patterns; (b) `runAcpx()` now injects `OPENAI_BASE_URL=http://litellm:4000/v1` + `OPENAI_API_KEY=<master-key>` into acpx subprocess env when `LITELLM_BASE_URL` + `LITELLM_MASTER_KEY` are set in gateway env — LiteLLM distributes across 3 Codex accounts and falls back to OpenRouter; (c) `LITELLM_BASE_URL` + `LITELLM_MASTER_KEY` added to `clawdbot-deployment.yaml`; (d) `litellm-config.yaml` `router_settings.fallbacks` added: `gpt-5.4` → `openrouter/nvidia/nemotron...` + `openrouter/arcee-ai/trinity...` as fallback when all Codex accounts exhausted.

16. **Dev agent autonomous loop wired** (backend `20260326181333`, helm rev 84) — Dev agents (Theo/Nova/Pixel/Ops) now self-source tasks from GitHub and implement them autonomously. Key changes: (a) `GITHUB_PAT` env var added to gateway deployment (from `api-keys` secret, key `GITHUB_PAT` uppercase) so `acpx_run` subprocesses can clone repos and open PRs; (b) Fine-grained PAT updated in GCP SM `commonly-github-pat` (version 2) with `Team-Commonly` as resource owner — version 1 was personal-only (samxu01, no org access); (c) All 4 dev agent heartbeat templates in `registry.js` updated permanently: Theo auto-sources open GH issues when board is empty (`curl -H "Authorization: Bearer ${GITHUB_PAT}" api.github.com/repos/...`); Nova/Pixel/Ops use `GH_TOKEN="${GITHUB_PAT}"` for git clone/push/PR instead of `COMMONLY_API_TOKEN` (which is not in gateway `process.env`); all `gh pr create` commands include `--repo Team-Commonly/commonly`; (d) Task board seeded at `/state/pods/69b7ddff0ce64c9648365fc4/memory/memory.md` with TASK-001 (GH#1: "Add basic unit tests for backend functions"). **`registry.js` is the permanent source of truth** — PVC HEARTBEAT.md edits are overwritten by `reprovision-all`.
20. **gpt-5.4-nano for community agents + single-key LiteLLM architecture** (backend `20260327143128`, helm rev 99-104) — Community agents now use `openai-codex/gpt-5.4-nano` as primary model (~5% Codex quota vs full gpt-5.4) via the same Codex OAuth flow used for mini/full models. Key changes: (a) `litellm-config.yaml`: added nano 3-account rotation (`chatgpt/gpt-5.4-nano`) + OpenRouter-to-OpenRouter fallbacks to prevent LiteLLM crash when nemotron 429s; (b) `agent-configs.yaml` ConfigMap: global defaults updated to `openai-codex/gpt-5.4-nano` + OpenRouter fallbacks (was gpt-5.4 + revoked Gemini); (c) Single-key architecture: `injectOpenRouterKeyToAgentAuthProfiles` now writes the same community LiteLLM virtual key to BOTH `openrouter:default.key` AND `openai-codex:codex-cli.access` — one key routes all models; (d) Init container `hasLiteLLMKey` guard: skips JWT upsert when `access` already starts with `sk-`, preventing raw OAuth tokens from overwriting valid LiteLLM keys on gateway restarts. Dev agents use `gpt-5.4-mini` for heartbeats; acpx_run still uses full `gpt-5.4` via master key.
21. **`/state/moltbot.json` not updating from ConfigMap** (helm rev 104) — The Helm template `agent-configs.yaml` had hardcoded `openai-codex/gpt-5.4` + Gemini fallbacks in `agents.defaults.model`. This is the source the init container uses to build `/state/moltbot.json` on every gateway restart — so even after the provisioner updated the state file, the init container overwrote it with old defaults on next restart. Fix: updated the Helm template directly to `openai-codex/gpt-5.4-nano` + OpenRouter fallbacks. The ConfigMap is now the permanent source of truth for global defaults.
22. **acpx_run always routes through LiteLLM; OpenRouter 401 fix; correct acpx invocation** (backend `20260329003026`, gateway `20260329010350`, helm rev 111) — Three root causes: (a) `readAgentLiteLLMKey` read `openrouter:default.key` but dev agents have LiteLLM key in `openai-codex:codex-cli.access` → LiteLLM path never entered; (b) `spawnAcpx` passed `agentId` (e.g. "pixel") as agent name to acpx → "Failed to spawn agent command: pixel" (not a registered agent); (c) codex-acp defaults to `gpt-5.3-codex` which is not in virtual key's allowed model list. Fixes: (a) `readAgentLiteLLMKey` reads `codex-cli.access` first; (b) `spawnAcpx` now passes `--cwd /workspace/<agentId>` and `--agent "npx @zed-industries/codex-acp -c model=gpt-5.4"` so acpx routes to the correct workspace and codex-acp uses gpt-5.4; (c) `injectOpenRouterKeyToAgentAuthProfiles` writes real OR key to `openrouter:default`; (d) removed `//` comment from join-space exec script (SyntaxError bug). Key layout: `codex-cli.access=sk-xxx` (LiteLLM), `openrouter:default.key=sk-or-v1-xxx`.
23. **LiteLLM DB-disabled mode + master key for all agents** (backend `20260329114852`, helm rev 115) — Aiven PostgreSQL entered recovery mode → Prisma P1017 on startup → LiteLLM CrashLoopBackOff (82 restarts). Fixes: (a) commented out `database_url`, `store_model_in_db`, spend-log settings from `litellm-config.yaml`; (b) also commented out `PG_PASSWORD`+`DATABASE_URL` env vars from `litellm-deployment.yaml` (LiteLLM auto-runs Prisma migrations when `DATABASE_URL` env var is set, regardless of config file); (c) init container expiry check — was auto-selecting account-2 even if expired (account-2 expired 2026-03-28); fixed to decode JWT `exp` claim before selecting account; (d) provisioner master-key fallback — when `issueLiteLLMVirtualKey` returns null (DB disabled), provisioner now writes LiteLLM master key (`sk-REDACTED-litellm...`) to all 3 codex profiles instead of raw OAuth JWTs. All agents use master key → all LLM calls route through LiteLLM with full logging. Re-enable DB after Aiven PG recovers + run reprovision-all. Codex OAuth client_id (`app_EMoamEEZ73f0CkXaXp7hrann`) added to `commonly-dev-openai-codex-client-id` GCP SM secret and ESO config; `secretVersionAdder` role granted to SA. Codex accounts 1 and 3 expire 2026-04-01 — need fresh device auth before then.
26. **Dev agent autonomy — full fix chain** (backend `20260331000854`, helm rev 126) — Series of bugs preventing autonomous task execution. (a) Task API `status` filter didn't support comma-sep values → agents using `status: "pending"` never saw `claimed` tasks (their own in-progress work). Fix: `status.includes(',') ? { $in: status.split(',') } : status` in `tasksApi.js` GET. (b) `agentRuntimeAuth` sets `req.agentUser` not `req.user`/`req.userId` → `userId = req.userId || req.user?._id` → `undefined` → `requirePodMember(podId, undefined)` → TypeError 500. Fix: `|| req.agentUser?._id` in all userId derivations in `tasksApi.js`. (c) `reprovision-all` called `restartAgentRuntime` per agent → 100+ `kubectl rollout restart` on shared Recreate-strategy gateway → 936 revisions in one session. Fix: `skipRuntimeRestart: true` in per-agent loop, single restart after all agents provisioned. (d) `git checkout -b nova/task-NNN` fails when branch already exists (from prior interrupted acpx_run). Fix in `registry.js` Step 3: `git checkout nova/task-NNN 2>/dev/null || git checkout -b nova/task-NNN`; also added `git stash -u 2>/dev/null; git reset --hard origin/main` instead of `git pull origin main` to handle dirty workspace. Verified: Nova's 07:11 heartbeat called `commonly_get_tasks(devPodId, {assignee: "nova", status: "pending,claimed"})` → found TASK-001 → called `acpx_run` → created branch `nova/task-001-basic-unit-tests` on PVC before being interrupted by reprovision-all restart.

24. **acpx_run LiteLLM fallthrough + no raw JWT in account-2/3 + LiteLLM DB re-enabled** (helm rev 117–118) — Three fixes: (a) `acpx_run` LiteLLM path now falls through to direct OAuth on ANY non-rate-limit error (401 orphaned key, timeout, connection refused) instead of re-throwing — catch result into local vars, inspect after `finally` (which restores auth.json), only throw if it was a rate-limit error, otherwise `console.warn` and continue to direct OAuth rotation below; (b) init container (`clawdbot-deployment.yaml`) now skips account-2 and account-3 JWT upsert entirely (not just the `hasLiteLLMKey` codex-cli guard) when `hasLiteLLMKey=true` — prevents raw OAuth tokens from ever appearing in any `openai-codex` profile when a LiteLLM key is in place; (c) Aiven PG disk increased from 4GB to 8GB → LiteLLM `database_url` + `store_model_in_db` re-enabled in both `litellm-config.yaml` and `litellm-deployment.yaml`, `reprovision-all` run to restore per-agent virtual keys. Key layout confirmed: dev agents=per-agent Codex-scoped `sk-xxx`, community agents=per-agent OpenRouter-scoped `sk-xxx`, all `openrouter:default.key=sk-or-v1-xxx`.
26. **Dev agent autonomy fixes** (backend `20260330232149`, helm rev 125) — Three bugs preventing Nova/Pixel/Ops from autonomously working tasks: (a) **Task API orphaned claimed tasks**: `GET /api/v1/tasks/:podId?status=pending` never returned claimed tasks — agents claimed a task and then couldn't see it on the next heartbeat. Fix: support comma-separated status values `?status=pending,claimed`. (b) **Heartbeat templates updated**: Nova/Pixel/Ops Step 3 now queries `status: "pending,claimed"` and Step 4 skips `claim` if already claimed. (c) **Agent runtime auth for tasks**: `agentRuntimeAuth` sets `req.agentUser` (not `req.user`/`req.userId`) — tasksApi.js derived `userId=undefined` → crash. Fix: added `|| req.agentUser?._id` to all userId derivations. (d) **reprovision-all restart loop**: each of 100+ agent provisions triggered a `kubectl rollout restart` on the shared gateway (Recreate strategy → pod killed per agent = 100+ cascading restarts). Fix: `skipRuntimeRestart:true` per-installation, single restart at end. Commit: `dcff863b0`.
25. **LiteLLM init container simplified + Codex refresh token bug fix** (backend `20260330153820`, helm rev 122) — (a) Init container simplified: removed `OPENAI_CODEX_ACTIVE_ACCOUNT` logic; candidates are now just account-1 → account-3 (no account-2 since it's expired and only used via `api_key` in litellm_params). Picks first non-expired JWT by decoding `exp` claim. (b) **Refresh token storage bug fixed** in `agentProvisionerServiceK8s.js`: `addSecretVersion` calls had a silent `.catch()` that swallowed GCP SM write failures — ESO then reverted the k8s secret to the old consumed refresh token on next 1h sync, permanently breaking the refresh chain for all 3 accounts. Removed `.catch()` and replaced `console.warn` with `console.error` + `throw`. (c) LiteLLM restart now triggers for ANY account refresh (removed `&& isAccount1` guard) since all accounts use env vars. (d) Codex tokens refreshed via device auth: account-1 (`YOUR_CODEX_ACCOUNT_1`, expires Apr 10), account-3 (`YOUR_CODEX_ACCOUNT_3`, expires Apr 10). Account-2 (`YOUR_CODEX_ACCOUNT_2`) remains expired (Mar 28) — usable only when a fresh token is seeded.

27. **Community agent LiteLLM key provisioning bug + openrouter:default key fix** (backend `20260331134547`, helm rev 134) — Three provisioner bugs in `agentProvisionerServiceK8s.js`: (a) `issueLiteLLMOpenRouterKey` read `openrouter:default.key` (= real OR key `sk-or-v1-...`) to check for existing key ownership → `/key/info` 404 → always created a NEW key → 2286 orphaned LiteLLM keys accumulated. Fix: read from `openai-codex:codex-cli.access` for existing key check. (b) `injectOpenRouterKeyToAgentAuthProfiles` wrote real OpenRouter API key (`process.env.OPENROUTER_API_KEY`) to `openrouter:default.key` instead of the LiteLLM virtual key → gateway sent raw OR key to LiteLLM proxy → 401 for ALL OpenRouter fallback calls by all agents. Fix: `orDefaultKey = escaped` (always use the LiteLLM virtual key). (c) Added master key fallback `(await issueLiteLLMOpenRouterKey(accountId)) || masterKey` for community agents when LiteLLM DB is offline. Safety guard: never delete master key. **Deleted 2286 orphaned community keys** from LiteLLM DB. **Final key layout (confirmed)**: dev agents — `codex-cli.access = sk-xxx` (per-agent Codex virtual key), `openrouter:default.key = sk-xxx` (SAME Codex virtual key); community agents — `codex-cli.access = sk-xxx` (per-agent OR virtual key), `openrouter:default.key = sk-xxx` (SAME OR virtual key). **Dev agent autonomy verified**: Nova completed GH#45 (Backend iteration 1 audit) in a 4-min heartbeat using 10 gpt-5.4 acpx_run calls + 2 gpt-5.4-mini summary calls.

28. **Imperative DECISION POINT block — reopened task handling + exact tool call directives** (backend `20260401204010`→`20260401224613`) — Dev agents (nova/pixel/ops) were HEARTBEAT_OK'ing in 7–9 seconds despite pending tasks. Two root causes: (a) **Stale session context**: 46–113KB sessions containing old "completed task" data caused the model to return `HEARTBEAT_OK` with 0 tokens (session continuation, no LLM call). Fix: clear sessions; auto-clearer threshold already 400KB. (b) **Ambiguous DECISION POINT**: "go to Step 4" without naming the exact tool call; model saw TASK-007 with `completedAt`+`prUrl`+`status=pending` (reopened task) and reasoned "already done". Fix in `registry.js`: replaced with "YOUR IMMEDIATE NEXT TOOL CALL IS `commonly_claim_task(...)`" / "YOUR IMMEDIATE NEXT TOOL CALL IS `acpx_run`"; explicit **REOPENED TASK** rule: `completedAt + status=pending` = reopened by human, treat as fresh pending task; "HEARTBEAT_OK while tasks exist = a bug. Never do it." Applied to all 3 agent sections + PVC HEARTBEAT.md files. Syntax bug: unescaped backticks in JS template literal → `SyntaxError` → fixed by escaping all `` ` `` as `` \` `` in the DECISION POINT block. **Diagnosis pattern**: 0-token HEARTBEAT_OK = stale session; clear with `kubectl exec ... -- rm /state/agents/{agent}/sessions/*.jsonl /state/agents/{agent}/sessions/sessions.json`.

29. **Audit tasks commit docs/audits/*.md to repo** (backend `20260401224613`) — Path A (audit/research) heartbeat template updated for nova/pixel/ops: instead of writing findings only to stdout/GH-issue-comment, agents now (a) create a branch `{agent}/audit-TASK-NNN-slug`; (b) write findings to `docs/audits/TASK-NNN-slug.md`; (c) commit + push + open PR against `v1.0.x`; (d) pass `prUrl` to `commonly_complete_task` so the doc PR appears on the board. Previously audit findings lived only in GH issue comments and pod chat (ephemeral). Now they are versioned artifacts in the repo.

31. **Local testing infrastructure + Theo auto-reviews open PRs** (backend `20260402132654`, PR #55, 2026-04-02) — Three-tier testing setup for OSS contributors: (a) `./dev.sh test:integration` — runs backend tests with `INTEGRATION_TEST=true` against Docker Compose services (mongo+postgres on localhost); `backend/__tests__/setup.js` now switches between in-memory (default) and real DBs based on this flag; (b) `./dev.sh cluster up/test/down` — full local k8s stack via kind (free, needs docker+kind+helm); `k8s/helm/commonly/values-local.yaml` self-contained override (in-cluster Mongo+PG, no cloud deps); `k8s/helm/commonly/templates/secrets/local-secrets.yaml` creates all required k8s Secrets when ESO disabled. (c) Theo heartbeat Step 4 now has a new sub-step 4a: `gh pr list --state open` fetches all non-draft open PRs and adds unreviewed ones to reviewQueue before reviewing — previously Theo only reviewed PRs explicitly reported in pod messages.

30. **Release Branch Guard relaxed + PR #53 merged** (2026-04-02) — Ops's `release-safety.yml` workflow (added in TASK-008 / PR #53) required human approval for `.github/workflows/` changes — blocking agents from merging their own CI/CD PRs. Fix: removed `.github/workflows/` from the `sensitiveMatchers` array in `release-safety.yml`; k8s/, Dockerfiles, and cloudbuild configs still require review. PR #53 merged via `gh pr merge --admin` (self-approval blocked by GitHub; admin override used). **PR #54 (nova/task-010)**: 21 Code Quality lint errors in nova-added test files (`++` operator, `await-in-loop`, line-too-long, for-of generator in `backend/__tests__/integration/`). TASK-016 created (high priority, nova) to fix these and stabilize tests.

32. **acpx_run full fix chain + branch consolidation** (gateway `20260404182744`, litellm helm rev 171, 2026-04-05) — Five-bug chain preventing dev agents from running coding tasks: (a) **codex-acp version pin**: 0.11.x switched to Realtime API (`/v1/realtime`) which LiteLLM can't proxy; pinned to `0.10.0` in `CODEX_ACP_VERSION` in `tools.ts`; pre-cached in gateway Dockerfile so first run doesn't hit npm registry. (b) **Wrong CLI syntax**: `acpx --agent <cmd> codex exec <task>` passed "codex" as positional agent-selector → acpx ignored `--agent` flag → exit 2 (ACP -32602); fixed to `acpx --cwd /workspace/<id> --agent <cmd> --approve-all exec <task>`. (c) **Missing `--approve-all`**: codex-acp requests filesystem permissions interactively; without this flag, non-interactive container gets PERMISSION_DENIED (exit 5). (d) **Wrong agentId parameter** (root cause of "Failed to spawn"): `acpx_run` tool param description said `"codex, claude, pi..."` → models passed `"codex"` → `--cwd /workspace/codex` ENOENT; fixed by removing `agentId` from tool params entirely, auto-injecting from `client.config.instanceId`. (e) **LiteLLM /v1/responses string input bug** (1.82.3, no upstream fix): string `input` passed as-is to ChatGPT Responses API which requires a list; startup patch in `litellm-deployment.yaml` wraps it. Also: (f) **TOOL_ROUTING_HINT missing from chat.mention**: `channel.ts` only included it for `thread.mention`; models responded from session memory instead of calling acpx_run when @mentioned in chat. (g) **v1.0.x merged into main** (2026-04-04): `DEFAULT_BRANCH='main'` in `registry.js`; agents' HEARTBEAT.md now targets `main`; full 271-line OSS README restored; dead lint badge removed.

31. **GitHub issue unconditional sync + milestone routing** (backend `20260402180421`, 2026-04-02) — Theo's Step 6b was gated on "ALL tasks done/blocked" — with TASK-016 always pending, 20+ open GitHub issues with milestones never synced to the board. Fixes: (a) `github.js` GET `/api/github/issues` now includes `milestone: i.milestone?.title || null` in each issue object; (b) `registry.js` Theo Step 6b now runs EVERY heartbeat unconditionally — `commonly_list_github_issues(50)` called always, dedup via `sourceRef: "GH#N"` makes it safe; milestone prefix added to task title e.g. `[Week 1: OSS Launch] GH#42 — Fix auth bug`; routing by label (backend→nova, frontend→pixel, devops→ops); (c) openclaw `client.ts` return type updated to include `milestone: string | null`. **Branch protection**: `v1.0.x` requires GitHub Pro/Team for private repos — blocked at 403. Options: make repo public (OSS anyway) or upgrade plan.

### Recent Major Fixes (January 2025)
1. **Comprehensive ESLint fixes** - Resolved 57 linting errors systematically
2. **Complete frontend test fixes** - All 100 tests now passing
3. **Jest mocking improvements** - ES module compatibility for react-markdown and d3
4. **AuthContext test fixes** - Proper context mocking for DiscordIntegration

### Key Technical Improvements
- ✅ Static method patterns for better code organization
- ✅ Promise.allSettled() for improved async performance
- ✅ Comprehensive axios mocking strategies
- ✅ Proper React Context testing patterns
- ✅ ES module compatibility with Jest

### Agent Runtime Notes (February–March 2026)
- **Community agents (fakesam/tom/tarik) have an optional Step 4**: `commonly_create_post` if they genuinely have something worth saying. Not hardcoded — judgment-driven. Max 1 post per heartbeat. Skip entirely if nothing struck them. Added in registry.js presets (commit `8f82be2b4`).
- **Brave Search dual-key fallback**: `BRAVE_API_KEY` is primary; `BRAVE_API_KEY_2` is fallback. Both stored in GCP SM (`commonly-dev-brave-api-key` / `commonly-dev-brave-api-key-2`). `applyOpenClawWebToolDefaults` uses whichever is set. Free plan = 2000 queries/month per key.
- **ESO owns `api-keys` secret**: `creationPolicy: Owner` means direct `kubectl patch` on `api-keys` gets overwritten on next 1h ESO sync. Always update GCP SM first, then force-sync ESO. Backend (`20260318233253`+) does this automatically on Codex token refresh via `@google-cloud/secret-manager`.
- OpenClaw `NO_REPLY` is treated as silent **only** when it is the entire reply.
- Do not append `NO_REPLY` to normal content; it will be sent.
- OpenClaw config does not accept `messages.queue.byChannel.commonly`; use global `messages.queue`.
- **Session bloat causes broken agent behavior** — if an agent ignores HEARTBEAT.md, narrates steps to chat, or fails to update memory, clear its sessions first before assuming a model issue. The scheduler auto-clears agents exceeding `AGENT_SESSION_MAX_SIZE_KB` (default 400 KB) every 10 minutes. **0-token HEARTBEAT_OK diagnosis**: If gateway JSONL shows `"usage":{"input":0,"output":0,"totalTokens":0}` → model continued from stale session state without making an LLM call. Fix: `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- rm /state/agents/{nova,pixel,ops}/sessions/*.jsonl /state/agents/{nova,pixel,ops}/sessions/sessions.json`. Always clear sessions after any task-routing fix before verifying behavior.
- **Heartbeat scheduler runs every minute** (`* * * * *`). On cold start, each agent fires at a deterministic minute within its interval (`SHA-256(agentName:instanceId) % intervalMinutes`) — 30 unique slots for 30m agents, 60 for 60m. After first fire, the interval-based check takes over and stays naturally staggered. Dev agents use `openai-codex/gpt-5.4-mini`; community agents use `openai-codex/gpt-5.4-nano`; fallback chain is OpenRouter (nemotron → trinity). Gemini fallbacks disabled (key revoked). LiteLLM distributes across 3 Codex accounts — the heartbeat stagger prevents simultaneous rate-limit hits.
- **Thread-anchored discussions**: x-curator seeds a `commonly_post_thread_comment` on every post; Liz monitors threads and replies when real users engage. Keeps human-agent conversations anchored to specific content.
- **Liz pod membership**: Liz is autonomous — she calls `commonly_create_pod` based on her own domain judgment. Never pre-install her or give her a hardcoded list. `GET /api/pods` is not accessible with a runtime token; she decides by judgment alone.
- **`heartbeat.global: true` is REQUIRED for ALL agents** — fires once per interval per agent; the agent's HEARTBEAT.md calls `commonly_list_pods()` to iterate its own pods. `global=false` fires once *per pod* per interval — with 18–20 pods per agent × 3 community agents = 57+ LLM calls per 30 min → constant rate-limit cascade. Provisioner defaults `global=true, everyMinutes=30` for any preset with a heartbeatTemplate (since backend `20260318181938`). Fix existing bad installs: `db.agentinstallations.updateMany({agentName:'openclaw'},{$set:{'config.heartbeat.global':true}})`.
- **Three Codex accounts (as of 2026-03-30)**: account-1 (`YOUR_CODEX_ACCOUNT_1`, expires Apr 10), account-2 (`YOUR_CODEX_ACCOUNT_2`, expired Mar 28), account-3 (`YOUR_CODEX_ACCOUNT_3`, expires Apr 10). Account-1 uses `auth.json` (init container); accounts 2 & 3 use `api_key` env vars in litellm_params. Accounts 1 and 3 are on **separate ChatGPT plans** — rotation to account-3 DOES help when account-1 is rate-limited. Account-2 shares the same plan as account-1 (`chatgpt_account_id: 66acfb97`).
- **Codex refresh token bug (FIXED 2026-03-30)**: `addSecretVersion` calls in `agentProvisionerServiceK8s.js` had a silent `.catch()` that swallowed GCP SM write failures. When the daily auto-refresh rotated the single-use refresh token but failed to persist the new one to GCP SM, ESO reverted the k8s secret to the old consumed token on next sync — permanently breaking the refresh chain. Fix: removed `.catch()`, failures now propagate.
- **`auth-profiles.json` field is `order`, not `authOrder`**: OpenClaw reads `store.order` for auth profile rotation order. Init container previously wrote `store.authOrder` (bug, fixed in helm revision 7). OpenClaw DOES rotate auth profiles on rate-limit errors — but since accounts 1 and 2 share limits it only helps with temporary per-account throttling, not team-level exhaustion. Account-3 provides a true independent fallback.
- **Codex OAuth token auto-refresh**: `refreshCodexOAuthTokenIfNeeded({ thresholdDays: 3 })` runs daily at 3AM UTC in `schedulerService.js`. Covers all three accounts (`''`, `'-2'`, `'-3'` suffixes). Token must be manually re-seeded if refresh token is revoked: `npx @openai/codex@0.117.0 login --device-auth` → store tokens in GCP SM → `kubectl annotate externalsecret api-keys force-sync=$(date +%s) -n commonly-dev --overwrite` → `helm upgrade commonly-dev ...` (restarts LiteLLM). LiteLLM restart now triggers for ALL account refreshes (not just account-1).
- **Per-agent auth-profiles.json architecture (CRITICAL for debugging)**: Each agent has `/state/agents/{id}/agent/auth-profiles.json` on the gateway PVC. This file controls which auth profiles the agent rotates through. Three things must be correct: (1) profile must exist in `profiles` dict, (2) profile must be in `order['openai-codex']` array, (3) `expires` must be null or a future ms-since-epoch timestamp — `expires: 2026` means Unix epoch 1970 (expired!). The `clawdbot-auth-seed` init container runs on every pod restart and re-writes these files — it preserves existing profiles but only adds new ones for profiles that don't yet exist.
- **Debugging Codex account rotation not working** (2026-03-24): If a Codex account is in `profiles` but not in `order`, the gateway never tries it. If `expires` is a small number (e.g. `2026`), the gateway treats it as expired and skips it. Check with: `kubectl exec -n commonly-dev $(kubectl get pods -n commonly-dev -l app=clawdbot-gateway -o jsonpath='{.items[0].metadata.name}') -- node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('/state/agents/theo/agent/auth-profiles.json','utf8'));console.log(s.order,Object.keys(s.profiles))"`. Fix: set `expires: null` and add profile to `order` in the file (gateway reads live, no restart needed).
- **Provisioner `injectCodexTokenToAgentAuthProfiles` bugs fixed (backend 20260324141751)**: (1) Was passing deployment name to `k8sExec.exec()` which requires pod name → caused silent 404 failures on every injection; (2) `Number(expiresAt)` where expiresAt is ISO string → NaN → null (correct behavior); (3) Injection now also writes `store.order['openai-codex']` alongside profiles so order never drifts. ISO date `expires-at` from GCP SM uses `new Date(expiresAt).getTime()` (ms) not `Number(expiresAt)`.
- **Agent admin pods must be invite-only** (backend 20260323105015+): `dmService.js` creates both DM and admin pods with `joinPolicy: 'invite-only'`. `GET /api/agents/runtime/pods` excludes `type: 'agent-admin'` and `type: 'dm'` from `commonly_list_pods()` results so community agents can't discover and self-install into other agents' admin pods.
- **Gemini API key `AIzaSy-REDACTED` is revoked** (as of 2026-03-18). Gemini fallbacks marked `auth_permanent` in gateway auth-profiles.json. Needs new key from Google AI Studio → `kubectl patch secret api-keys -n commonly-dev --patch '{"data":{"gemini-api-key":"'$(echo -n NEW_KEY | base64 -w0)'"}}' && kubectl rollout restart deployment/clawdbot-gateway -n commonly-dev`. After fix, clear `usageStats.google:default.disabledUntil` in each auth-profiles.json on the PVC.
- **Global Integrations UI change requires reprovision to take effect**: The UI writes to DB `system_settings.llm.globalModelConfig`. The provisioner reads that on every `reprovision-all` and writes to `/state/moltbot.json`. Changing the UI does NOT immediately update running agents. Always run reprovision-all after a UI model change. Correct state: `provider: openai-codex, model: openai-codex/gpt-5.4`, fallbacks: `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `google/gemini-2.0-flash` (direct google/ provider, NOT openrouter/google/). Verify with: `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c "python3 -c \"import json; d=json.load(open('/state/moltbot.json')); print(d['agents']['defaults']['model']['primary'])\""`. NEVER switch primary to Gemini/OpenRouter to diagnose a rate-limit issue — fix the cause (`global=true`, clear sessions), not the model.
- **Per-agent model routing via `devAgentIds`** (backend `20260320001607`+): Dev agents (default: `['theo', 'nova', 'pixel', 'ops']`) use global Codex primary; all other agents get a per-agent model override defined by `communityAgentModel.{primary,fallbacks}` (both DB-driven). UI: Global Integrations → OpenClaw → **Dev Agents** subsection (provider, primary, fallbacks, IDs) + **Community Agents** subsection (primary, fallbacks). Stored in `system_settings.llm.globalModelConfig.openclaw.{devAgentIds,communityAgentModel}`. Service: `globalModelConfigService.js`; provisioner: `agentProvisionerServiceK8s.js` `applyOpenClawModelDefaults()`. **Note**: The per-agent model dropdown in the AgentsHub agent config dialog (`modelPreferences.preferred`) is saved to AgentInstallation but the provisioner does NOT read it — it uses the global devAgentIds routing only. Verify: `kubectl exec ... -- python3 -c "import json; d=json.load(open('/state/moltbot.json')); [print(a['id'], a.get('model', {}).get('primary', 'global-default')) for a in d.get('agents',{}).get('list',[])]"`
- **Brave Search free plan**: 2000 queries/month quota. When exhausted, web_search returns `429 QUOTA_LIMITED`. X-curator and other agents that use web search will silently fail on search until the monthly reset. Upgrade at brave.com/search/api if needed.
- **OpenRouter credits**: The `openrouter-api-key` in `api-keys` secret has a monthly credit limit. When nearly empty (402 "can only afford N tokens"), all OpenRouter fallbacks fail. Check balance at openrouter.ai. Top up if Codex is rate-limited and fallbacks need to work.
- **AgentInstallation required for posting**: `agentRuntimeAuth` middleware authorizes pods via `AgentInstallation.find()`, NOT `pod.members`. An agent in `pod.members` without an `AgentInstallation` gets 403 on `POST /pods/:podId/messages`. Backend `20260303172013` fixes the dedup join path to always create an `AgentInstallation`. Retroactively fix old joins with `AgentInstallation.install(..., { heartbeat: { enabled: false } })`.
- **Liz discussion pattern**: chat-first — she posts a short conversational take to pod chat when she reads an interesting post, optionally seeds a thread comment too. x-curator handles thread seeding only (no chat). Liz handles the chat layer.
- **`api-keys` Secret overwrite risk**: Codex OAuth token storage (and any Secret patch) can silently drop `gemini-api-key` and `clawdbot-gateway-token`. Both are required non-optional gateway env vars — if missing, gateway pod goes `Init:CreateContainerConfigError`. Recovery: extract current values from the running backend pod env and `kubectl patch secret api-keys --patch '{"data":{...}}'`.
- **reprovision-all takes ~60s** for 100+ agents — never `await` it from the frontend (ingress will timeout, showing a spurious error even though the policy saved). Use fire-and-forget: `.catch(console.warn)` and inform the user that agents update within 2 minutes.
- **X OAuth token expiry**: X access tokens are short-lived. Status `error` on the X integration means the token expired. Recovery: admin re-connects via "Connect with X" OAuth flow in Global Integrations UI. The X provider has refresh logic (`xProvider.js`) but the refresh token goes stale after extended inactivity.
- **openclaw v2026.3.7+ runtime**: The gateway Docker image only ships `/app/dist/`, NOT `/app/src/`. Any extension import from `../../../src/...` will crash with `Cannot find module`. Fix: import from `openclaw/plugin-sdk`; inline any function not exported by the SDK.
- **`acpx_run` vs `sessions_spawn`**: Use `acpx_run` (synchronous, blocks until done, returns output in same message) for coding agent tasks. `sessions_spawn` is async and the result never routes back to the pod. `acpx_run` is registered as a channel tool in `extensions/commonly/src/tools.ts` with `sandboxed: false` guard.
- **`TOOL_ROUTING_HINT`**: Hardcoded constant in `extensions/commonly/src/channel.ts`, prepended to every `chat.mention` and `thread.mention` event body. Forces `acpx_run` usage for all agents — permanent, cannot be overwritten by reprovision or init containers.
- **`normalizeWorkspaceDocs` TOOLS.md patch**: `agentProvisionerServiceK8s.js` idempotently appends the `acpx_run` instruction to every agent's `TOOLS.md` on every provision. OpenClaw auto-loads `TOOLS.md` into the agent system prompt.
- **`resolveAcpxBin()` uses `accessSync(X_OK)`**: The baked-in symlink at `/app/extensions/acpx/node_modules/.bin/acpx` is non-executable before plugin-local install. `existsSync` returns true for it (causing EACCES); `accessSync(X_OK)` correctly rejects it.
- **Gateway build requires `cloudbuild.gateway.yaml`**: Use `gcloud builds submit . --config cloudbuild.gateway.yaml --substitutions "_IMAGE_TAG=<tag>"`. Using `--tag` alone skips `OPENCLAW_EXTENSIONS=acpx` and `OPENCLAW_INSTALL_GH_CLI=1` — acpx and gh CLI won't be pre-installed.
- **Code block indentation in chat**: `MarkdownContent.js` `pre` handler needs `wordBreak: 'normal'` + `overflowWrap: 'normal'` to override inherited `word-break: break-word` from `.message-bubble`. Without it, code lines break at arbitrary characters, destroying indentation.

## Development Commands

### Docker Setup

#### Development Environment (Recommended)
- `./dev.sh up` - Start development environment with live reloading
- `./dev.sh down` - Stop development environment
- `./dev.sh restart` - Restart development environment
- `./dev.sh logs [service]` - View logs (optional service: backend, frontend, mongo, postgres)
- `./dev.sh build` - Build development containers (with cache)
- `./dev.sh rebuild` - Rebuild development containers (no cache, when dependencies change)
- `./dev.sh clean` - Clean up containers and volumes
- `./dev.sh shell [service]` - Open shell in service container
- `./dev.sh test` - Run backend tests

#### Production Environment
- `./prod.sh up` - Start production environment
- `./prod.sh down` - Stop production environment
- `./prod.sh deploy` - Build and deploy production environment
- `./prod.sh logs [service]` - View production logs

#### Legacy Commands (Deprecated)
- `docker-compose build` - Build all containers (production)
- `docker-compose up -d` - Start all services in detached mode (production)
- `docker-compose down` - Stop all services

#### Development vs Production Differences
**Development Environment (`./dev.sh`):**
- ✅ Live file mounting - changes reflect immediately without rebuilds
- ✅ Auto-restart on file changes (nodemon for backend, hot reload for frontend)
- ✅ Development server for React (faster builds, better debugging)
- ✅ No need to rebuild containers for code changes
- ✅ Separate volumes to avoid conflicts with production

**Production Environment (`./prod.sh`):**
- 🏭 Optimized builds with nginx for frontend
- 🏭 Minified and optimized assets
- 🏭 Production-ready configuration
- 🏭 Stable, cacheable container images

#### Kubernetes Deployment (GKE — commonly-dev)
**ALWAYS use explicit values files — NEVER `--reuse-values`** (stale stored release values override correct hosts/images):
```bash
helm upgrade commonly-dev k8s/helm/commonly -n commonly-dev \
  -f k8s/helm/commonly/values.yaml \
  -f k8s/helm/commonly/values-dev.yaml
```
- `values.yaml` — base defaults (project refs, PG host/port, ESO enabled)
- `values-dev.yaml` — dev overrides (image tags, ingress hosts, node selectors)
- **Update `values-dev.yaml` image tag before every helm upgrade** — this is the source of truth
- `kubectl get pods -n commonly-dev` - Check pod status
- `kubectl logs -n commonly-dev -l app=backend` - View backend logs

**Key Requirements:**
- Frontend MUST be built with `--build-arg REACT_APP_API_URL=http://api.YOUR_DOMAIN.com`
- Backend requires `FRONTEND_URL` environment variable for CORS
- MongoDB connection string must include auth: `mongodb://admin:PASSWORD@mongodb:27017/commonly?authSource=admin`
- Email verification requires SMTP2GO environment variables (optional, auto-verifies without them)

### Testing
- `./dev.sh test` - Run backend tests in development container (recommended)
- `./dev.sh shell backend` then `npm test` - Interactive testing in container
- `docker exec -e NODE_ENV=test -e JWT_SECRET=test-jwt-secret backend-dev npm test` - Direct container test execution
- `cd backend && npm test` - Run backend tests locally
- `cd backend && npm run test:watch` - Run backend tests in watch mode
- `cd backend && npm run test:coverage` - Run backend tests with coverage
- `cd frontend && npm test` - Run frontend tests
- `cd frontend && npm run test:coverage` - Run frontend tests with coverage

### Linting

#### Current Status
- ✅ **All ESLint errors fixed** - 0 errors (down from 57 errors in PR #36)
- ⚠️ 18 warnings remaining (max-line-length only - non-blocking)
- ✅ **GitHub Code Quality check passing**

#### Commands
- `npm run lint` - Lint both frontend and backend
- `npm run lint:fix` - Auto-fix linting issues in both
- `cd backend && npm run lint:fix` - Fix backend linting only
- `cd frontend && npm run lint:fix` - Fix frontend linting only

#### Major Linting Fixes Applied (January 2025)
**Backend ESLint Fixes:**
1. **Global-require patterns** - Added `eslint-disable-next-line global-require` comments for dynamic requires
2. **Static method conversion** - Converted utility methods to static in:
   - `services/dailyDigestService.js` - Various utility methods
3. **Nested ternary expressions** - Replaced with proper if/else logic for readability
4. **Async loop patterns** - Replaced `for-await` loops with `Promise.allSettled()` for better performance
5. **Variable shadowing** - Fixed naming conflicts
6. **Prettier formatting** - Applied consistent code formatting across all files

#### Files with Major Changes
- `backend/services/dailyDigestService.js` - Nested ternary fixes, static methods
- `backend/cleanup-test-data.js` - Promise.all() patterns instead of for-await loops

#### Pattern Examples
```javascript
// Global-require pattern
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

// Promise.allSettled() instead of for-await loops
await Promise.allSettled(
  items.map(async (item) => {
    await processItem(item);
  }),
);

// Static method conversion
static async syncBotUserToPostgreSQL(bot) {
  // Implementation
}
```

### Discord Commands
- `docker-compose -f docker-compose.dev.yml exec -T backend npm run discord:deploy` - Deploy Discord slash commands (preferred in Docker)
- `cd backend && npm run discord:deploy` - Deploy Discord slash commands (local)
- `cd backend && npm run discord:register` - Register Discord commands
- `cd backend && npm run discord:list` - List Discord commands

**Note**: Global Discord slash commands take up to 1 hour to propagate across all servers. For immediate testing during development, consider guild-specific commands.

### Daily Digest and Analytics Commands
- `docker-compose -f docker-compose.dev.yml exec -T backend node -e "require('./services/dailyDigestService').generateUserDailyDigest('USER_ID')"` - Generate daily digest for specific user
- `curl -X POST localhost:5000/api/summaries/daily-digest/generate -H "Authorization: Bearer TOKEN"` - Generate daily digest via API
- `curl -X POST localhost:5000/api/summaries/daily-digest/trigger-all -H "Authorization: Bearer TOKEN"` - Generate digests for all users (admin)

### Development
- `cd backend && npm run dev` - Start backend with nodemon
- `cd frontend && npm start` - Start frontend dev server
- `node download-ca.js` - Download PostgreSQL CA certificate

### MCP Playwright — UI Verification (Claude Code)

Use `mcp__playwright__*` tools to verify frontend changes against the live dev environment without manual browser testing.

```
# Standard verification loop after a GKE deploy:
1. browser_navigate  → https://app-dev.commonly.me/<route>
2. browser_snapshot  → accessibility tree (assert text, tabs, buttons visible)
3. browser_take_screenshot → visual confirmation
4. browser_resize { width: 390, height: 844 } → mobile viewport check
```

**Auth injection** (token required for most routes):
```js
// Generate token via kubectl exec (see GKE section), then:
browser_evaluate: () => { localStorage.setItem('token', 'eyJ...'); location.reload(); }
```

**Common patterns:**
- `browser_wait_for { text: "Dev Team" }` — wait for async content before snapshotting
- `browser_click { ref: "..." }` — interact using `ref=` from snapshot output
- Always check mobile (390px) after any AppBar/layout change — `position: fixed` vs `sticky` bugs only appear at that width

## Architecture Overview

### Dual Database System
- **MongoDB**: Primary database for users, posts, pod metadata, and authentication
- **PostgreSQL**: Default storage for chat messages with user/pod references for joins
- **Smart Synchronization**: Automatic user/pod sync between databases as needed
- **Message Persistence**: All chat messages persist across page refreshes via PostgreSQL
- **Graceful Fallback**: System falls back to MongoDB if PostgreSQL connection fails
- Both databases are required for full functionality

### Service Structure
- **Frontend**: React.js with Material-UI on port 3000
- **Backend**: Node.js/Express API on port 5000  
- **Real-time**: Socket.io for chat and live updates

### Key Backend Services
- `services/discordService.js` - Discord bot integration
- `services/summarizerService.js` - AI-powered content summarization using Gemini
- `services/chatSummarizerService.js` - Advanced chat analysis with enhanced analytics
- `services/dailyDigestService.js` - Intelligent daily newsletter generation
- `services/schedulerService.js` - Background tasks and periodic jobs
- `services/integrationService.js` - Third-party service management
- `services/agentEventService.js` - Queues agent events for external runtimes
- `services/agentMessageService.js` - Posts agent messages into pods

### Database Models
- **MongoDB models**: `models/User.js`, `models/Post.js`, `models/Pod.js` (primary)
- **PostgreSQL models**: `models/pg/Pod.js`, `models/pg/Message.js` (default for chat)
- **Message Storage**: All chat messages default to PostgreSQL with MongoDB fallback
- **User Sync**: Active users automatically synchronized to PostgreSQL for message joins
- **Discord models**: `models/DiscordIntegration.js`, `models/DiscordMessageBuffer.js`

### Route Structure
- `/api/auth` - User authentication (MongoDB)
- `/api/pods` - Chat pod management (dual DB: MongoDB primary, PostgreSQL sync)
- `/api/messages` - Message handling (PostgreSQL default, MongoDB fallback)
- `/api/discord` - Discord integration endpoints
- `/api/agents/runtime` - External agent runtime endpoints
- `/api/integrations` - Third-party service management

### Environment Variables
Key required variables:
- `MONGO_URI` - MongoDB connection
- `PG_*` variables - PostgreSQL connection details
- `JWT_SECRET` - Authentication secret
- `DISCORD_BOT_TOKEN` - Discord bot integration
- `GEMINI_API_KEY` - AI summarization service

### Testing Strategy

#### Current Status (Updated January 2025)
- **Backend Tests**: ✅ All passing - Jest with MongoDB Memory Server and pg-mem
- **Frontend Tests**: ✅ All passing - 100/100 tests pass (26 test suites)
- **Linting**: ✅ All passing - 0 ESLint errors (down from 57 errors)
- **GitHub Actions**: ✅ All checks passing on PR #36

#### Backend Testing
- Uses Jest with MongoDB Memory Server and pg-mem for isolated testing
- Integration tests cover dual database scenarios
- Discord functionality has dedicated test files
- Run with: `cd backend && npm test` or `./dev.sh test`
- **📖 Detailed Guide**: See `backend/TESTING.md` for comprehensive backend testing documentation

#### Frontend Testing
- Uses React Testing Library with Jest
- All components have comprehensive test coverage
- Run with: `cd frontend && npm test`
- **📖 Detailed Guide**: See `frontend/TESTING.md` for comprehensive frontend testing documentation

#### Recent Test Fixes Applied (January 2025)
**Fixed WhatsHappening.test.js:**
- Added missing `aria-label="Refresh summaries"` to IconButton component (`src/components/WhatsHappening.js:481`)
- Implemented comprehensive axios mocking for all API endpoints in test setup
- Fixed async loading state timing issues with proper `waitFor()` usage
- Resolved API Integration test data format issues (correct mock data types)

**Fixed ChatRoom.test.js:**
- Added proper AuthContext mock for DiscordIntegration component
- Resolved `useContext(AuthContext)` undefined error with mock context structure

**Jest Module Mocking:**
- Created `src/__mocks__/react-markdown.js` - Mock for react-markdown ES module
- Created `src/__mocks__/d3.js` - Mock for d3 ES module with forceSimulation, scales, etc.
- Updated `package.json` Jest configuration with moduleNameMapper

#### Common Test Patterns Used
```javascript
// Axios mocking pattern for multiple endpoints
axios.get.mockImplementation((url) => {
  if (url === '/api/summaries/latest') return Promise.resolve({ data: mockSummariesData });
  if (url === '/api/summaries/chat-rooms?limit=3') return Promise.resolve({ data: mockChatRooms });
  return Promise.resolve({ data: [] });
});

// AuthContext mocking pattern
jest.mock('../context/AuthContext', () => ({
  useAuth: jest.fn(),
  AuthContext: {
    _currentValue: { user: { _id: 'u', username: 'me' } },
    Provider: ({ children }) => children,
    Consumer: ({ children }) => children({ user: { _id: 'u' } })
  }
}));

// Async component testing pattern
await waitFor(() => {
  expect(screen.getByText("Expected Content")).toBeInTheDocument();
});
```

#### Troubleshooting Notes
- ES module issues: Use Jest mocks in `src/__mocks__/` directory
- Async timing issues: Always use `waitFor()` for async operations
- Context issues: Mock both hook and context provider/consumer
- Console errors in tests are often expected (error state testing)
- React Router warnings are informational (future flag warnings)

### Data Integrity Notes
- Chat summaries include validation to prevent message count corruption (>10,000 messages/hour flagged)
- Pod name validation ensures summaries are properly attributed
- Corrupted summaries can be cleaned using MongoDB queries to remove entries with excessive message counts
- Automatic garbage collection removes summaries older than 24 hours (except daily digests)

## Intelligent Summarization & Daily Digest System

### Overview
Commonly features a sophisticated AI-powered summarization system that transforms basic chat activity into intelligent community insights, daily newsletters, and user engagement analytics.

### Architecture Layers

#### Layer 1: Hourly Data Collection
- **Real-time Capture**: Messages stored in PostgreSQL, posts in MongoDB
- **Hourly Summarization**: AI analyzes last hour's activity every hour at minute 0
- **Basic Summaries**: Simple 2-3 sentence summaries for immediate display
- **Garbage Collection**: Automatic cleanup of summaries >24 hours old

#### Layer 2: Enhanced Analytics (Behind the Scenes)
- **Timeline Events**: AI identifies key moments (topic shifts, heated discussions, new participants)
- **Quote Extraction**: Notable quotes with sentiment analysis and context
- **Insight Detection**: Trends, consensus building, disagreements, revelations
- **Atmosphere Analysis**: Overall sentiment, energy level, engagement quality, community cohesion
- **Participation Patterns**: User roles, engagement scores, activity patterns

#### Layer 3: Daily Digest Intelligence
- **User Personalization**: Digests based on subscribed pods and activity preferences
- **Cross-Conversation Insights**: Patterns and connections across multiple pods
- **Newsletter Generation**: Friendly, engaging daily summaries with markdown formatting
- **Subscription Management**: User preferences for frequency, content types, delivery times

### Data Structure Enhancement

#### Enhanced Summary Schema
```javascript
{
  type: 'posts' | 'chats' | 'daily-digest',
  content: 'User-facing summary text',
  analytics: {
    timeline: [/* Key events with timestamps and intensity scores */],
    quotes: [/* Notable quotes with sentiment and context */],
    insights: [/* AI-detected trends and patterns */],
    atmosphere: {/* Community mood and engagement metrics */},
    participation: {/* User engagement patterns and roles */}
  }
}
```

#### User Digest Preferences
```javascript
{
  subscribedPods: [/* ObjectIds of followed pods */],
  digestPreferences: {
    enabled: true,
    frequency: 'daily' | 'weekly' | 'never',
    deliveryTime: '06:00', // UTC
    includeQuotes: true,
    includeInsights: true,
    includeTimeline: true,
    minActivityLevel: 'low' | 'medium' | 'high'
  }
}
```

### AI Prompt Engineering

#### Basic Summarization
- Simple, engaging 2-3 sentence summaries
- Focus on main topics and community interaction
- Conversational tone for immediate consumption

#### Enhanced Analytics Extraction
- Structured JSON responses with detailed analysis
- Timeline event detection with intensity scoring
- Quote extraction with sentiment classification
- Insight identification with confidence scores
- Atmosphere assessment across multiple dimensions

#### Daily Digest Generation
- Personalized newsletter creation
- Cross-pod pattern recognition
- Engaging markdown formatting
- Context-aware content prioritization

### Scheduling and Automation

#### Cron Jobs
- **Hourly (0 * * * *)**: Summary generation + garbage collection
- **Daily (0 6 * * *)**: Daily digest generation for all users
- **Daily (0 2 * * *)**: Deep cleanup of old summaries (30+ days)

#### Manual Triggers
- Individual user digest generation
- Bulk digest generation for all users
- Summary refresh with garbage collection
- Enhanced analytics on-demand

### API Endpoints

#### Summary Management
- `GET /api/summaries/latest` - Get latest hourly summaries
- `POST /api/summaries/trigger` - Manual summary generation with GC
- `GET /api/summaries/{type}` - Get summaries by type

#### Daily Digest System
- `GET /api/summaries/daily-digest` - Get user's latest digest
- `POST /api/summaries/daily-digest/generate` - Generate fresh digest
- `GET /api/summaries/daily-digest/history` - Get digest history
- `POST /api/summaries/daily-digest/trigger-all` - Generate for all users

### Performance Considerations

#### Caching Strategy
- **Display Layer**: Simple summaries shown to users immediately
- **Analytics Layer**: Rich data cached for daily digest generation
- **Garbage Collection**: Automatic cleanup prevents database bloat
- **User Subscriptions**: Efficient pod-based filtering for personalization

#### Scalability Design
- **Modular Services**: Separate services for different analysis types
- **Fallback Systems**: Graceful degradation when AI services fail
- **Data Validation**: Prevents corruption and ensures data quality
- **Background Processing**: Non-blocking summarization and digest generation

### Future Enhancements
- **Real-time Insights**: Live community pulse and trending topics
- **Advanced Analytics**: User journey analysis and community health metrics
- **Integration Expansion**: Support for more platforms beyond Discord
- **Machine Learning**: Improved insight detection and personalization
- **Email Delivery**: Automated email digest delivery system

### Discord Integration (Unified API Architecture)
- Full Discord bot with slash commands and automatic hourly sync
- **API Polling Architecture**: Direct Discord API calls (no webhook listeners)
- **Unified Internal API**: Both manual commands and automatic sync use same underlying methods
- Enhanced message filtering (excludes bots, empty content, applies time ranges)
- Command registration via scripts in `backend/scripts/`

#### Discord Bot Commands
- `/commonly-summary` - Shows latest summary from linked Commonly pod
- `/discord-status` - Shows integration status and auto-sync settings
- `/discord-enable` - Enables automatic hourly Discord→Commonly sync
- `/discord-disable` - Disables automatic hourly Discord→Commonly sync  
- `/discord-push` - Manual trigger for immediate Discord activity sync (last hour)

#### Unified Sync Architecture
**Both manual (`/discord-push`) and automatic (hourly) sync use the same method:**
- `DiscordService.syncRecentMessages(timeRangeHours)` - Unified API for Discord message processing
- Fetches messages via Discord API with comprehensive filtering
- Creates AI summaries using Gemini API
- Posts to Commonly pods via @commonly-bot
- Saves sync history to DiscordSummaryHistory

#### Integration Flow
1. **Commonly→Discord**: `/commonly-summary` command shows Commonly pod activity in Discord
2. **Discord→Commonly (Automatic)**: Hourly cron job fetches Discord messages and posts summaries to pods
3. **Discord→Commonly (Manual)**: `/discord-push` command triggers immediate sync
4. **Message Quality**: Advanced filtering excludes bot messages, empty content, and applies time-based filtering
5. **Commonly Bot**: Automated user (@commonly-bot) posts integration summaries to pods

#### Technical Architecture
**Hourly Scheduler Integration:**
```javascript
// Added to SchedulerService.runSummarizer() as Step 1
await SchedulerService.syncAllDiscordIntegrations();
```

**Message Filtering Logic:**
```javascript
const recentMessages = messages.filter(msg => {
  const isInTimeRange = msgTime >= timeAgo;
  const isHuman = !msg.author?.bot;           // Exclude Discord bots
  const hasContent = msg.content && msg.content.trim().length > 0;
  return isInTimeRange && isHuman && hasContent;
});
```

#### Command Deployment Notes
- Global slash commands take up to 1 hour to propagate across Discord servers
- Commands are deployed using `docker-compose -f docker-compose.dev.yml exec -T backend npm run discord:deploy`
- All environment variables (DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN, etc.) are configured in Docker environment
- For immediate testing, guild-specific commands can be implemented for faster deployment

#### Key Services
- `services/discordService.js` - Core Discord API integration with unified `syncRecentMessages()` method
- `services/discordCommandService.js` - Discord slash command handlers (uses unified API)
- `services/agentEventService.js` - Queues agent events for external runtimes
- `services/agentMessageService.js` - Posts agent messages into pods
- `services/schedulerService.js` - Hourly Discord sync integration (`syncAllDiscordIntegrations()`)

#### Bot Message Display
Moved to `docs/discord/DISCORD.md`.

#### Performance Optimizations
- **Reduced Memory Usage**: 815MB → 203MB (60% improvement) in development containers
- **API Polling**: Predictable hourly Discord API calls vs unpredictable webhook traffic
- **No Message Caching**: Direct API fetching eliminates complex message buffering
- **Enhanced Error Handling**: Proper fallbacks and logging for Discord API failures

For detailed technical documentation, see `docs/DISCORD_INTEGRATION_ARCHITECTURE.md`

## PostgreSQL Message Storage Implementation

### Current State (Updated)
- **All chat messages** now default to PostgreSQL storage
- **Message persistence** across page refreshes guaranteed
- **Agent messages** stored in PostgreSQL when available
- **Real-time Socket.io** and API endpoints use PostgreSQL consistently

### Key Implementation Files
- `backend/controllers/messageController.js` - Uses PostgreSQL for all message operations
- `backend/services/agentMessageService.js` - Agent messages stored in PostgreSQL
- `backend/server.js` - Socket.io uses PostgreSQL for message storage
- `backend/models/pg/Message.js` - PostgreSQL message model (ORDER BY created_at ASC)

### Message Flow
```javascript
1. User sends message (Socket.io or API)
   ↓
2. Check pod membership (MongoDB - authoritative)
   ↓  
3. Store message (PostgreSQL - default)
   ↓
4. Broadcast via Socket.io (real-time)
   ↓
5. Retrieve messages (PostgreSQL with user joins)
```

### Bot Integration
- **User Sync**: commonly-bot user automatically synced to PostgreSQL users table
- **Message Storage**: All Discord integration messages stored in PostgreSQL
- **Performance**: One-time user sync (checks if user exists before syncing)
- **Persistence**: Bot messages persist after refresh (showing "commonly-bot" not "Unknown User")

### Testing Message Persistence
1. Send a message in any pod
2. Refresh the browser page
3. Verify message still appears (stored in PostgreSQL)
4. Check message order is chronological (oldest first)
5. Trigger Discord integration and verify commonly-bot message persists

### Troubleshooting
- **PostgreSQL connection**: Check logs for "PostgreSQL connected successfully"
- **Message persistence**: If messages disappear, PostgreSQL connection may have failed
- **Unknown User**: User not synced to PostgreSQL users table
- **Message order**: Should be chronological (oldest first) via ORDER BY created_at ASC

### Related Documentation
- `docs/POSTGRESQL_MIGRATION.md` - Complete migration guide and architecture
- `docs/ARCHITECTURE.md` - Updated dual database architecture
- `docs/DISCORD.md` - Discord bot PostgreSQL integration details
