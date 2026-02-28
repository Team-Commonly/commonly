# Claude / Codex Skills

These are **local development context files** used by Claude Code (`.claude/skills/`) and Codex (`.codex/skills/`).

## What These Are

Markdown files that give Claude Code (and Codex) structured context about specific subsystems — routing, database, agents, etc. They are loaded as skill context during coding sessions.

**These are NOT read by OpenClaw agents at runtime.** They exist purely to help Claude Code understand the codebase.

## Two Distinct Skill Systems

| | Local Claude/Codex Skills | Clawdbot Workspace Skills |
|---|---|---|
| **Location** | `.claude/skills/` and `.codex/skills/` (in repo) | `/workspace/<id>/skills/` (on gateway PVC in K8s) |
| **Read by** | Claude Code / Codex during dev sessions | OpenClaw agents at every session bootstrap |
| **Modified by** | Developers (committed to git) | Developers via `kubectl exec` OR agents themselves (anti-pattern) |
| **Purpose** | Coding context for AI pair programmer | Runtime instructions for autonomous agents |
| **Synced?** | `.claude/` → `.codex/` manually kept in sync | `/workspace/_master/skills/` seeds new agent workspaces |

## Clawdbot Workspace Skill Paths (K8s)

```
/workspace/_master/skills/<skill>/SKILL.md   ← template, seeds new agent workspaces
/workspace/<agent-id>/skills/<skill>/SKILL.md ← per-agent live copy, read each heartbeat
/config/moltbot.json                          ← ConfigMap, agent config read by gateway
/state/moltbot.json                           ← PVC, read by init container at pod startup
```

**Editing clawdbot skills** (no reprovision needed for PVC file changes):
```bash
kubectl exec -n commonly-dev <gateway-pod> -- vi /workspace/<id>/skills/commonly/SKILL.md
# OR
kubectl cp ./local-file.md commonly-dev/<gateway-pod>:/workspace/<id>/skills/commonly/SKILL.md
```

**Editing master template** (affects new provisioned agents):
```bash
kubectl cp ./SKILL.md commonly-dev/<gateway-pod>:/workspace/_master/skills/commonly/SKILL.md
```

## Keeping Them in Sync

`.claude/skills/` is the source of truth. After editing a skill, copy it to `.codex/skills/`:
```bash
cp .claude/skills/<name>/SKILL.md .codex/skills/<name>/SKILL.md
```

Check what's out of sync:
```bash
diff -rq .claude/skills/ .codex/skills/
```
