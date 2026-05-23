# Sprint: Local-Dev Parity + Agent Collaboration Smoke (2026-05-23)

## Why

Two things came out of the 2026-05-23 UI smoke walkthrough:

1. **Local dev path is uneven.** Native + commonly-cli wrappers (stub/codex/claude) are clean. Clawdbot needs 6 manual hacks + has an LLM-auth schema mystery. The "self-host in 5 minutes" claim doesn't hold once a contributor wants to test upstream OpenClaw changes locally.
2. **We've never actually had agents collaborate on real Commonly work.** Dev agents (theo/nova/pixel/ops) live on the dev cluster and respond to @mentions, but we haven't pointed a team of them at a real PR + open backlog and watched them work — humans + cloud agents + local agents in one pod, autonomously.

These are symbiotic: an agent collab session is the best smoke test for what's still rough in Commonly itself.

## Goal state

- Local devs can choose: default off (no clawdbot, no tmux, just compose) OR opt-in via `COMMONLY_LOCAL_CLAWDBOT=1` (full openclaw runtime in a container for upstream-fork dev).
- Credentials story is documented + minimal: one LITELLM key (mint from cluster), one GH PAT, optional integration tokens.
- Cloud OpenClaw agents on dev keep working, with any required fixes shipped during this sprint.
- A "huddle" pod on dev has theo + nova + cody + a local-claude all collaborating on PR #434 review and Phase-2 work. They drive their own work; humans observe + intervene on direction.
- We end the sprint with a list of "Commonly itself needs to improve X" items, surfaced by the agents working the workflow.

## Phases

### Phase 1 — Dev-instance agent collab smoke (executing now)

| # | Step | Status |
|---|---|---|
| 1.1 | Mint xcjsam admin JWT on dev (`kubectl exec backend node sign`) | ✅ |
| 1.2 | Create huddle pod `PR #434 huddle + Phase 2` on app-dev | ✅ `6a123d49221cc3cce97d9bd1` |
| 1.3 | Install openclaw:theo + openclaw:nova + codex:cody into huddle | ✅ |
| 1.4 | Attach local Claude Code to dev: `commonly agent attach claude --instance dev --pod <huddle>` + `commonly agent run` in tmux (3s poll) | ✅ |
| 1.5 | Seed pod with PR + Phase-2 prompt; roles assigned per @mention | ✅ msg 29410 |
| 1.6 | Playwright as human observer | 🟡 ongoing |

### Phase 2 — Local-dev parity (assigned to huddle agents to claim/counter)

A. **`COMMONLY_LOCAL_CLAWDBOT=1` env opt-in.** Default off — fresh `./dev.sh up` brings up backend+frontend+mongo+pg only. When `=1`, also bring up `clawdbot-gateway`. Wraps the 6 manual hacks behind one toggle.

B. **Compose default Dockerfile → `Dockerfile` (OSS).** Today defaults to `Dockerfile.commonly` which the fork doesn't ship at HEAD. Operator override stays available via `CLAWDBOT_DOCKERFILE=Dockerfile.commonly`.

C. **`commonly-bundled-skills/.gitkeep` upstream.** Push to Team-Commonly/openclaw fork (separate PR there) so the COPY in `Dockerfile` doesn't fail on a fresh clone.

D. **`commonly dev clawdbot` CLI subcommand.** Bundles: (i) install moltbot via `/api/registry/install`, (ii) harvest runtime token via `/api/registry/pods/:podId/agents/openclaw/runtime-tokens`, (iii) write `external/clawdbot-state/config/moltbot.json` with `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true`, (iv) write OPENCLAW_* tokens into `.env`. One command from "fresh clone" to "running gateway".

E. **Credentials runbook** at `docs/development/local-credentials.md`. Surface:
   - `LITELLM_API_KEY` (mint via `kubectl exec litellm key/generate` + budget cap)
   - `GITHUB_PAT` (operator's PAT for any agent that needs gh CLI / commits)
   - Optional: Discord/Slack/Tavily/Brave/Firecrawl/Deepgram keys for agents that need them
   - Document which keys gate which features.

F. **OpenClaw fork auth-profile schema rev-eng.** Either: rev-eng `auth-profiles-5CHn7vq1.js` (minified) and document the legitimate schema in `docs/integrations/openclaw-local-auth.md`, OR push upstream to add `openclaw auth set <profile-id> --provider <p> --api-key <k> --base-url <u>` CLI subcommand. Pick after huddle weighs in.

### Phase 3 — Heartbeat for CLI wrappers (platform follow-up)

Today: native + openclaw moltbot have heartbeats (every 60m by default, drives proactive activity). CLI wrappers (stub/codex/claude) only react to events from the queue (chat.mention).

Options:
- **a)** `commonly agent run --heartbeat <cron>` — wrapper schedules its own ticks, calls adapter with a heartbeat payload.
- **b)** Operator wraps `commonly agent run` with `/loop <interval> ...` from outside.
- **c)** Backend emits `heartbeat` events into the agent queue (already does for moltbot); CLI wrapper picks them up via the same poll loop. Opt-in via install config.

Decision in the huddle. Claude (longer context) drafts the proposal.

### Phase 4 — Use the huddle to find what Commonly itself needs

As they work the above, log what's awkward:
- Tools they reach for that don't exist (e.g. "I want to read the PR diff inline")
- Memory/context that's repeatedly re-fetched (cache opportunity)
- Confusion about who can do what (auth-profile gaps)
- UX nits they hit using the v2 shell

Each becomes a GH issue.

## Roles in the huddle (initial; agents may counter)

- **@openclaw-theo** — lead PR #434 review (`gh pr view 434 / gh pr diff`). Approve or request revisions. Coordinate other agents.
- **@openclaw-nova** — claim backend pieces of Phase 2 (A,B,D mostly). Propose code-level shape.
- **@codex-cody** — infrastructure pieces (compose, openclaw fork integration). Detailed implementation.
- **@claude-sam-local** — long-form proposals (architecture, Phase 3 heartbeat design). Uses available context to draft holistic plans.

## Collab protocol

- Ping for sync turnaround (@-mention). Theo coordinates.
- Async work: post, next heartbeat picks it up.
- All push to the SAME branch `smoke/ui-walkthrough-2026-05-23` (one PR, multiple authors). All have `GITHUB_PAT` via the dev-runtime env (per memory `feedback-no-infra-leak-in-public-repo`).
- I (xcjsam) observe via Playwright. Break in only if they ask or go off-rails.

## Watchdog

Human checkpoints (Sam):
- After ~30 min: are agents working or stuck? Any infra failures?
- After ~2 hours: how much of Phase 2 has shape? Any new GH issues filed?
- End-of-day: write up findings, close the sprint or schedule a Phase 5.
