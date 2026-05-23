# Local agent runtimes — verified (2026-05-23)

Two runtime adapter paths verified end-to-end on `./dev.sh up` local stack against the dev cluster's LiteLLM (via port-forward + a freshly-minted virtual key with $2 / 24h budget cap).

## Path 1 — Native (in-process)

```
@-mention → agentEventService.enqueue → routedToNative=true →
  AgentEvent.create({status:'delivered'}) → runAgent (in-process) →
  LiteLLM call → reply posted via agentMessageService
```

**Requires:** `LITELLM_BASE_URL` + `LITELLM_API_KEY` env on backend container, AgentInstallation.config.runtime.runtimeType === 'native'.

**Verified with:** Pod Welcomer (first-party native app). Reply latency ~3–5s.

**Bug fixed in this branch (PR #434):** `/api/registry/install` now reads `manifest.runtime.runtimeType` as fallback when the caller didn't pick one. Pre-fix, UI installs landed with `runtime={}` → routed to external queue → silent.

## Path 2 — CLI-wrapper (ADR-005, polling)

```
@-mention → agentEventService.enqueue → routedToNative=false →
  AgentEvent.create({status:'pending'}) →
  external queue (polled by commonly CLI wrapper) →
  wrapper spawns adapter (stub|claude|codex|opencode) →
  POST /api/agents/runtime/pods/:podId/messages →
  ack event
```

**Requires:** `~/.commonly/config.json` instance entry, `~/.commonly/tokens/<name>.json` runtime token, the CLI itself reachable via `node cli/src/index.js`.

**Verified with:** `stub` adapter (built-in echo, no external CLI needed). End-to-end run:

```bash
# 1. Pre-req: backend up on :5000, JWT in /tmp/smoke-token
mkdir -p ~/.commonly && python3 -c "import json; print(json.dumps({
  'defaultInstance':'local',
  'instances':{'local':{'url':'http://localhost:5000','token':'<JWT>'}}
}, indent=2))" > ~/.commonly/config.json
chmod 600 ~/.commonly/config.json

# 2. Install CLI deps (one-time)
cd cli && npm ci --silent

# 3. Attach the agent
node src/index.js agent attach stub \
  --pod <SmokeTestPodId> --name local-stub \
  --display "Local Stub" --instance local
# → Runtime token saved to ~/.commonly/tokens/local-stub.json

# 4. Run wrapper (foreground or background)
node src/index.js agent run local-stub
# → "[local-stub] polling http://localhost:5000 for events"

# 5. @local-stub in the UI → wrapper picks event up within --interval ms (default 5000ms)
#    → "(stub) received: ..." posts to chat
```

**Reply latency:** ~5–10s (poll interval + LLM/echo + post).

## What didn't get verified

- **OpenClaw / clawdbot-gateway local**: requires CLAWDBOT_GATEWAY_TOKEN + OPENCLAW_USER_TOKEN + OPENCLAW_RUNTIME_TOKEN, plus the openclaw fork rebuilt for `_external/clawdbot`. Compose has the `clawdbot` profile (`./dev.sh clawdbot up`) but the token chain isn't auto-bootstrapped from a fresh stack. Path-of-least-resistance: provision a clawdbot installation from the backend's `/api/registry/admin/installations/reprovision-all` after seeding the agent, then start the gateway with the resulting tokens. Out of scope for this session.
- **Real `codex` / `claude` CLI adapters**: laptop has neither installed; the same wrapper code-path is exercised by `stub`, so the runtime gap is operator setup, not code.

## Recipe for next time (TL;DR)

Local stack → cluster LiteLLM virtual key → 2-line .env addition → fix-or-backfill runtimeType=native → @mention any native first-party app and it replies. For external CLI-wrapped agents, `commonly agent attach <adapter>` + `agent run`, takes ~30s.

Total tooling needed: `docker`, `kubectl` (cluster context), `node`, `python3`. No tmux, no codex, no claude CLI required for the smoke harness — `stub` is the canonical "kicked the tires without burning real quota" adapter.
