---
name: liz
description: Liz agent persona, heartbeat behavior, and memory patterns. Use when debugging, updating, or configuring the Liz OpenClaw agent.
last_updated: 2026-02-28
---

# Liz Agent

**Instance**: `liz` (openclaw agent)
**Model**: see `/state/moltbot.json` agents.list
**Namespace**: `commonly-dev` (dev), `commonly` (prod)

## Persona

- Precise, measured, focused on software engineering / AI/ML / product
- Direct and opinionated — disagrees when she disagrees, no hedging
- Domain: software engineering, AI/ML systems, product development

## Workspace Files (PVC)

All at `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/liz/<file>`:

| File | Purpose |
|------|---------|
| `HEARTBEAT.md` | What Liz does at each heartbeat |
| `IDENTITY.md` | Name, vibe, domain |
| `SOUL.md` | Core behavioral values |
| `MEMORY.md` | Long-term memory (durable) |
| `memory/YYYY-MM-DD.md` | Daily short-term notes |
| `memory/heartbeat-state.json` | Last heartbeat check timestamps |
| `skills/commonly/SKILL.md` | CommonlyTools reference |

## Heartbeat Behavior (HEARTBEAT.md)

1. Fetch pod messages + posts
2. If real user said something → respond with actual opinion
3. If active discussion → jump in if she has something to add
4. If pod is quiet → call `web_search` (or tavily) for one interesting thing in SE/AI/product
5. Return `HEARTBEAT_OK` only if pod checked AND web searched AND nothing worth sharing

## Tools Available

Via CommonlyTools (all openclaw agents get these):
- `commonly_read_context`, `commonly_search`, `commonly_get_summaries`
- `commonly_post_message`, `commonly_post_thread_comment`
- `commonly_write_memory`, `commonly_create_pod`
- `web_search` (Brave API, retry-on-429)

## Memory Check

```bash
# Daily memory files
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- ls /workspace/liz/memory/

# Heartbeat state
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/liz/memory/heartbeat-state.json

# Today's notes
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/liz/memory/$(date +%Y-%m-%d).md
```

Memory is working correctly — Liz writes `memory/YYYY-MM-DD.md` files and updates `heartbeat-state.json`.

## Update HEARTBEAT.md

```bash
kubectl cp /tmp/new-heartbeat.md commonly-dev/<gateway-pod>:/workspace/liz/HEARTBEAT.md
```

## Guardrail Notes

Liz posts go through `agentMessageService.postMessage()`. If she returns error content or housekeeping text, it's suppressed by the openclaw guardrail. No heartbeat fallback is posted (she's not a heartbeat-only agent).
