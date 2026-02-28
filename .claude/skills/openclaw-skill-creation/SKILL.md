---

name: openclaw-skill-creation
description: Create or update OpenClaw (Cuz/Clawdbot/Moltbot) skills and Commonly MCP skill prompts; include legacy names and runtime constraints.
last_updated: 2026-02-27
---

# OpenClaw Skill Creation

Use this skill when creating or updating OpenClaw skills, including the Commonly MCP skill used by the OpenClaw runtime.

## Legacy Names

OpenClaw is also known as:
- **Cuz** (display persona)
- **Clawdbot** (legacy runtime)
- **Moltbot** (current runtime name)

Include these names in skill descriptions and examples so older references still map correctly.

## Two Distinct Skill Systems — Do Not Confuse

### 1. Local Claude/Codex Skills (dev context)
- **Location**: `.claude/skills/` and `.codex/skills/` in the repo
- **Read by**: Claude Code and Codex during development sessions
- **NOT read by agents at runtime**
- Kept in sync via `cp .claude/skills/<x>/SKILL.md .codex/skills/<x>/SKILL.md`

### 2. Clawdbot Workspace Skills (agent runtime context)
- **Location**: on the gateway PVC in K8s (below)
- **Read by**: OpenClaw agents as bootstrap context at every session start
- Agents can self-modify these files — see agent-runtime skill for anti-pattern warning

```
/workspace/_master/skills/<skill>/SKILL.md   ← template, seeds new agent workspaces at provision time
/workspace/<agent-id>/skills/<skill>/SKILL.md ← per-agent live copy, loaded each heartbeat
/config/moltbot.json                          ← ConfigMap, runtime agent config (gateway process)
/state/moltbot.json                           ← PVC, read by clawdbot-auth-seed init container
```

**Edit a live agent skill** (takes effect on next heartbeat, no reprovision):
```bash
GATEWAY=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway -o name | head -1)
kubectl cp .claude/skills/commonly/SKILL.md commonly-dev/${GATEWAY#pod/}:/workspace/<agent-id>/skills/commonly/SKILL.md
```

**Edit master template** (affects newly provisioned agents):
```bash
GATEWAY=$(kubectl get pods -n commonly-dev -l app=clawdbot-gateway -o name | head -1)
kubectl cp .claude/skills/commonly/SKILL.md commonly-dev/${GATEWAY#pod/}:/workspace/_master/skills/commonly/SKILL.md
```

## Requirements

- Skills should be concise and tool-oriented.
- Prefer explicit parameters and clear examples.
- Avoid tool chatter in outputs (no channel/tool debug text).

## Mention + Runtime Constraints

- OpenClaw responses are posted by `external/commonly-agent-services/clawdbot-bridge`.
- Avoid instructions that require Discord/Telegram/Slack channel IDs unless the skill is channel-specific.

## References

- [CLAWDBOT.md](../../../docs/agents/CLAWDBOT.md)
- [AGENT_RUNTIME.md](../../../docs/agents/AGENT_RUNTIME.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)

## Current Repo Notes (2026-02-27)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.

**Workspace skill anti-pattern**: agents can self-modify `/workspace/<id>/skills/*/SKILL.md` during a session and write
invented tool names (e.g. `commonly_read_context`). These silently fail. Always verify workspace skills after a confused
agent session. See agent-runtime skill for full debug checklist.
