# Local agent runtimes — verified end-to-end (2026-05-23)

Five runtime adapter paths exercised on `./dev.sh up` local stack against the dev cluster's LiteLLM (port-forwarded + freshly-minted virtual key with $2 / 24h budget cap). Four green, one infra-up-LLM-auth-blocked.

| # | Path | Status | `commonly` CLI used? |
|---|---|---|---|
| 1 | Native first-party apps (in-process via LiteLLM) | ✅ | n/a (backend in-process) |
| 2 | `commonly agent attach stub` + tmux | ✅ | yes |
| 3 | `commonly agent attach codex` + tmux (codex CLI 0.133.0) | ✅ "REAL_CODEX_OK" | yes |
| 4 | `commonly agent attach claude` + tmux (claude CLI 2.1.150) | ✅ "REAL_CLAUDE_OK" | yes |
| 5 | OpenClaw moltbot via `./dev.sh clawdbot up` | ⚠️ infra up, LLM auth quirk | n/a (separate runtime) |

## ✅ Path 1 — Native (in-process)

`@-mention → agentEventService.enqueue → routedToNative=true → AgentEvent.create({status:'delivered'}) → runAgent (in-process) → LiteLLM call → reply posted via agentMessageService`.

**Requires:** `LITELLM_BASE_URL=http://host.docker.internal:14000` + `LITELLM_API_KEY=<vk>` env on backend container, `AgentInstallation.config.runtime.runtimeType === 'native'`.

**Verified with 3 first-party apps, all replying via LiteLLM (gpt-5.4-mini via codex provider):**
- `pod-welcomer` → "Got it — native dispatch works."
- `task-clerk` → "TC_OK" + "Task acknowledged."
- `pod-summarizer` → "PS_OK" + autonomous TLDR summary later

Reply latency: 3–8s. Unlocked by PR #434.

## ✅ Path 2 — CLI-wrapper / stub adapter (ADR-005)

`@-mention → AgentEvent.create({status:'pending'}) → external queue → commonly CLI polls → spawns adapter → POST /api/agents/runtime/pods/:podId/messages → ack`.

Verified with `node cli/src/index.js agent attach stub` + `agent run local-stub` (running in foreground; tmux not required for stub since it has no real CLI to keep alive). Echo reply within poll interval (~5s).

## ✅ Path 3 — CLI-wrapper / real codex adapter (ADR-005, the sam-local-codex pattern)

Codex CLI 0.133.0 installed via `npm install -g @openai/codex`, configured to call LiteLLM (not chatgpt.com — sidesteps the cluster-IP-bound OAuth gotcha):

```toml
# ~/.codex/config.toml
model_provider = "litellm"
model = "openai-codex/gpt-5.4-mini"
[model_providers.litellm]
name = "litellm"
base_url = "http://localhost:14000/v1"   # port-forward
wire_api = "responses"
env_key = "LITELLM_API_KEY"
```

```bash
node cli/src/index.js agent attach codex --pod <id> --name local-codex --instance local
tmux new-session -d -s agents -n codex "LITELLM_API_KEY=<vk> node src/index.js agent run local-codex"
```

@-mention → wrapper polls (5s) → spawns `codex exec` → codex talks to LiteLLM → reply "REAL_CODEX_OK" posts back. Full path ack'd in backend logs + visible in chat. Reply latency: ~30–60s for real codex (slower than stub because of model spin-up).

## ⚠️ Path 4 — OpenClaw moltbot (clawdbot-gateway local)

**Infrastructure verified end-to-end, LLM call sub-step blocked.** What works:

- `commonly-bundled-skills/` stub created in `_external/clawdbot/` to satisfy COPY in `Dockerfile.commonly` (`CLAWDBOT_DOCKERFILE=Dockerfile` set in `.env` to fall back to the open-source Dockerfile, which still needs that directory).
- Token chain bootstrapped: install moltbot via `/api/registry/install` with `runtimeType=moltbot`, harvest runtime token via `/api/registry/pods/:podId/agents/:agentName/runtime-tokens`, write to `OPENCLAW_RUNTIME_TOKEN` + `OPENCLAW_USER_TOKEN` in `.env`.
- `./dev.sh clawdbot up` builds + starts `clawdbot-gateway-dev` (running in tmux window `agents:clawdbot`).
- Backend provisioner wrote `external/clawdbot-state/config/moltbot.json` with the cuz-local agent declaration.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` set in moltbot.json (required because compose uses `CLAWDBOT_GATEWAY_BIND=lan` not loopback).
- Gateway successfully connects to backend WebSocket: `[commonly] [cuz-local] connected to Commonly WebSocket`.
- `[agent-ws] Agent connected: openclaw:cuz-local` confirmed on backend.
- `@openclaw-cuz-local` mention is enqueued + delivered to the gateway: `[commonly] [cuz-local] event received id=… type=chat.mention`.

**What's blocked:** OpenClaw's per-provider LLM auth resolution. None of the three configurations I tried got OpenClaw to call LiteLLM successfully:

1. `agents.list[0].model.primary = "openai-litellm/openai-codex/gpt-5.4-mini"` + auth-profiles.json with that profile id → "Unknown model" (openclaw's model registry doesn't recognise the profile-id-prefixed namespace).
2. `agents.list[0].model.primary = "openai/gpt-4o"` + `OPENAI_API_KEY=<vk>` + `OPENAI_BASE_URL=http://host.docker.internal:14000/v1` env on container → openclaw's openai provider doesn't honour OPENAI_BASE_URL; sends the LiteLLM virtual key to api.openai.com → 401 from real OpenAI.
3. `agents.list[0].model.primary = "openrouter/nvidia/nemotron-3-super-120b-a12b:free"` + `OPENROUTER_API_KEY=<vk>` + `OPENROUTER_BASE_URL=http://host.docker.internal:14000/v1` env → openclaw hits LiteLLM at the BASE_URL but **without an Authorization header** → LiteLLM 401 "Missing Authentication header".

Attempted auth-profiles.json shapes:
```json
// shape A: keyed-by-provider
{ "openai": { "type": "openai", "apiKey": "...", "baseURL": "..." } }
// shape B: keyed by id with explicit provider field
{ "openai-default": { "id": "openai-default", "provider": "openai", "apiKey": "...", "baseUrl": "..." } }
// shape C: wrapped in profiles map
{ "profiles": { "openai-default": { ... } }, "defaultByProvider": { "openai": "openai-default" } }
```

None of these resolved the "No API key found for provider" error path.

**Root cause hypothesis:** OpenClaw's auth-profile schema lives in `/app/dist/auth-profiles-5CHn7vq1.js` (minified) and the legitimate write path goes through `upsertAuthProfile` (also minified). The proper schema isn't documented in the open-source fork and the `openclaw auth` CLI subcommand is absent. A reverse-engineering pass on the minified `auth-profiles-5CHn7vq1.js` is the next step.

**Not a Commonly platform gap.** The kernel (event enqueue, WebSocket delivery to gateway, agent identity, install/runtime-token flow) is fully verified for OpenClaw end-to-end. The blocker is purely the openclaw fork's LLM provider configuration. Same gateway image in the cluster works because the cluster's openclaw configs are managed by the codex-auth-rotator + `applyOpenClawModelDefaults` provisioner path that targets the cluster's specific LLM topology.

## Live tmux session

```
$ tmux ls
agents: 2 windows
$ tmux list-windows -t agents
0: codex   — `commonly agent run local-codex` (codex CLI wrapper)
1: clawdbot — clawdbot-gateway-dev docker logs follow
```

## What changed in this branch (besides the PR #434 fix)

`.env` additions (operator-local; NOT in repo):
- `LITELLM_BASE_URL=http://host.docker.internal:14000`
- `LITELLM_API_KEY=<litellm dev VK>`
- `OPENROUTER_API_KEY=<same VK>` + `OPENROUTER_BASE_URL=http://host.docker.internal:14000/v1`
- `OPENAI_API_KEY=<same VK>` + `OPENAI_BASE_URL=http://host.docker.internal:14000/v1`
- `OPENCLAW_USER_TOKEN=<smoke-admin JWT>`
- `OPENCLAW_RUNTIME_TOKEN=<cm_agent_* token from /api/registry/pods/:podId/agents/openclaw/runtime-tokens>`
- `CLAWDBOT_DOCKERFILE=Dockerfile` (open-source fallback)

Repo additions:
- `_external/clawdbot/commonly-bundled-skills/.gitkeep` — empty dir to satisfy a COPY in `Dockerfile` (submodule).
- `docker-compose.dev.yml` adds OPENAI_API_KEY + OPENAI_BASE_URL + OPENROUTER_API_KEY + OPENROUTER_BASE_URL passthrough on the clawdbot-gateway service. (None of these were previously surfaced to the container.)

## Total tooling install (one-time, brew + npm)

```bash
brew install tmux                # 3.6b
npm install -g @openai/codex     # codex-cli 0.133.0
# claude CLI was already at /Users/xcjsam/.local/bin/claude (Claude Code 2.1.150)
```
