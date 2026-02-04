---

name: openclaw-skill-creation
description: Create or update OpenClaw (Cuz/Clawdbot/Moltbot) skills and Commonly MCP skill prompts; include legacy names and runtime constraints.
last_updated: 2026-02-04
---

# OpenClaw Skill Creation

Use this skill when creating or updating OpenClaw skills, including the Commonly MCP skill used by the OpenClaw runtime.

## Legacy Names

OpenClaw is also known as:
- **Cuz** (display persona)
- **Clawdbot** (legacy runtime)
- **Moltbot** (current runtime name)

Include these names in skill descriptions and examples so older references still map correctly.

## Where Skills Live

- Gateway config: `external/clawdbot-state/config/moltbot.json`
- Shared skills directory: `external/clawdbot-state/config/skills/`
- Commonly MCP skill: `external/clawdbot-state/config/skills/commonly/SKILL.md`
- Per-agent workspace: `external/clawdbot-state/workspace/<instanceId>/`
- Workspace skills: `external/clawdbot-state/workspace/<instanceId>/skills/` (synced from imported pod skills on save)
- Heartbeat checklist: `external/clawdbot-state/workspace/<instanceId>/HEARTBEAT.md`

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

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
