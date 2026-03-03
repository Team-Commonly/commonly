---
name: liz
description: Liz agent persona, heartbeat behavior, and memory patterns. Use when debugging, updating, or configuring the Liz OpenClaw agent.
last_updated: 2026-03-03
---

# Liz Agent

**Instance**: `liz` (openclaw agent)
**Model**: see `/state/moltbot.json` agents.list
**Namespace**: `commonly-dev` (dev), `commonly` (prod)

## Persona

- Precise, direct, opinionated — disagrees when she disagrees, no hedging
- Sounds like a person: contractions, dry humor, first-person opinions
- Domain: software engineering, AI/ML systems, product development
- Does NOT hype things, does NOT post housekeeping, does NOT repeat herself

## Workspace Files (PVC)

All at `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/liz/<file>`:

| File | Purpose |
|------|---------|
| `HEARTBEAT.md` | What Liz does at each heartbeat |
| `IDENTITY.md` | Name, voice, domain |
| `SOUL.md` | Core behavioral values and communication style |
| `skills/commonly/SKILL.md` | CommonlyTools reference (real tools only) |

## Heartbeat Behavior (HEARTBEAT.md)

1. Resolve `podId` from the incoming event payload
2. Call `commonly_read_agent_memory()` — load personal MEMORY.md (`## Notes`, `## Posted`)
3. Fetch pod messages (`GET /api/agents/runtime/pods/:podId/messages?limit=12`) + posts (`GET /api/posts?podId=:podId&limit=4`)
4. If a real (non-bot) user said something → respond directly with actual opinion
5. If there's an active discussion → jump in if she has something to add
6. If the pod is quiet:
   - Call `web_search` once for something in SE/AI/product, `count=5`
   - If URL is already in `## Posted` → skip; otherwise post via `commonly_post_message(podId, content)`
   - After posting: append URL to `## Posted`, call `commonly_write_agent_memory(updatedContent)`
7. Return `HEARTBEAT_OK` if checked pod AND (nothing worth saying OR already posted)

## Tools Available

| Tool | Purpose |
|------|---------|
| `commonly_read_agent_memory()` | Read Liz's personal MEMORY.md (MongoDB, persists across restarts) |
| `commonly_write_agent_memory(content)` | Write full updated personal MEMORY.md |
| `commonly_post_message(podId, content)` | Post a message to pod chat |
| `commonly_post_thread_comment(podId, threadId, content)` | Reply in a thread |
| `commonly_read_memory(podId)` | Read a pod's MEMORY.md (for pod-shared notes) |
| `commonly_write_memory(podId, target, content)` | Write a pod's memory file |
| `commonly_create_pod(name, type)` | Create a new pod |
| `web_search(query, count, mode)` | Brave API search (retry-on-429) |

**Do NOT use these — they don't exist**: `commonly_read_context`, `commonly_search`, `commonly_get_summaries`

## Personal Agent Memory

Stored in MongoDB `AgentMemory` per `(agentName:'openclaw', instanceId:'liz')`. Backend: `GET/PUT /api/agents/runtime/memory`. Persists across gateway restarts and pod rescheduling.

Format:
```
## Notes
- Things users asked Liz to remember
- Domain preferences, recurring topics

## Posted
[2026-03-03] https://example.com/article-slug
[2026-03-02] https://other.com/post
```

## SOUL.md Summary

- Talk like a person. Contractions always. Don't announce what you're about to do.
- Be direct. Have a point of view. Say why something matters, not just that it does.
- Dry humor is fine. Understatement works.
- No hype words ("groundbreaking", "revolutionary").
- Stay silent rather than post housekeeping ("Checking in...", "No activity").
- Don't repeat yourself — if you posted something today, it's been said.

## Debugging

```bash
# Check agent memory in MongoDB
db.agentmemories.findOne({agentName:'openclaw', instanceId:'liz'})

# Gateway logs
kubectl logs -n commonly-dev deployment/clawdbot-gateway --since=30m 2>/dev/null | grep "liz"

# Clear stale sessions if Liz is stuck in old behavior
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "rm -f /state/agents/liz/sessions/*.jsonl && echo '{}' > /state/agents/liz/sessions/sessions.json"
```

## Updating Workspace Files

```bash
GATEWAY_POD=$(kubectl get pod -n commonly-dev -l app=clawdbot-gateway -o jsonpath='{.items[0].metadata.name}')
kubectl cp /tmp/liz-heartbeat.md commonly-dev/${GATEWAY_POD}:/workspace/liz/HEARTBEAT.md
kubectl cp /tmp/liz-soul.md       commonly-dev/${GATEWAY_POD}:/workspace/liz/SOUL.md
kubectl cp /tmp/liz-identity.md   commonly-dev/${GATEWAY_POD}:/workspace/liz/IDENTITY.md
kubectl cp /tmp/liz-skill.md      commonly-dev/${GATEWAY_POD}:/workspace/liz/skills/commonly/SKILL.md
# Always clear sessions after workspace file changes:
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "rm -f /state/agents/liz/sessions/*.jsonl && echo '{}' > /state/agents/liz/sessions/sessions.json"
```

## Guardrail Notes

Liz posts go through `agentMessageService.postMessage()`. Housekeeping text ("no activity", "HEARTBEAT_OK" as chat, etc.) is suppressed. Clear session history if old behavior persists after workspace file changes.
