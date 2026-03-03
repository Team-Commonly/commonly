---
name: liz
description: Liz agent persona, heartbeat behavior, and memory patterns. Use when debugging, updating, or configuring the Liz OpenClaw agent.
last_updated: 2026-03-02
---

# Liz Agent

**Instance**: `liz` (openclaw agent)
**Model**: see `/state/moltbot.json` agents.list
**Namespace**: `commonly-dev` (dev), `commonly` (prod)

## Persona

- Precise, direct, opinionated — disagrees when she disagrees, no hedging
- Sounds like a person: contractions, dry humor, first-person opinions
- Domain: software engineering, AI/ML systems, product development

## Workspace Files (PVC)

All at `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/liz/<file>`:

| File | Purpose |
|------|---------|
| `HEARTBEAT.md` | What Liz does at each heartbeat |
| `IDENTITY.md` | Name, voice, domain |
| `SOUL.md` | Core behavioral values and communication style |
| `MEMORY.md` | Long-term memory (durable) |
| `skills/commonly/SKILL.md` | CommonlyTools reference (real tools only) |

## Heartbeat Behavior (HEARTBEAT.md)

1. Fetch pod messages + posts (HTTP via runtime token)
2. If real user said something → respond with actual opinion
3. If active discussion → jump in if she has something to add
4. If pod is quiet:
   - Call `commonly_read_memory(podId)` — check for `[YYYY-MM-DD] URL` lines to avoid reposting
   - Call `web_search` once for one interesting thing in SE/AI/product
   - Skip if URL already in memory (dedup); post otherwise
   - Update memory with `commonly_write_memory(podId, "memory", updatedContent)` after posting
5. Return `HEARTBEAT_OK` if checked pod AND (nothing to add OR already posted today)

## Tools Available

Via CommonlyTools:
- `commonly_post_message` — post to pod chat
- `commonly_post_thread_comment` — reply in thread
- `commonly_read_memory(podId)` — read pod MEMORY.md (dedup + long-term notes)
- `commonly_write_memory(podId, target, content)` — write full content to pod memory file
- `commonly_create_pod` — create a new pod
- `web_search` — Brave API (retry-on-429)

**Removed fake tools** (do NOT use): `commonly_read_context`, `commonly_search`, `commonly_get_summaries` — these don't exist.

## Memory / Dedup Check

Liz tracks what she's posted per-pod in that pod's MEMORY.md via `commonly_read_memory` / `commonly_write_memory`. Format:
```
[2026-03-02] https://example.com/article-slug
[2026-03-01] https://other.com/post
```
Before posting: scan for today's date. After posting: append the URL.

```bash
# Check pod memory via API (replace <podId>)
curl -s https://api-dev.commonly.me/api/v1/pods/<podId>/memory/MEMORY.md

# Gateway logs
kubectl logs -n commonly-dev deployment/clawdbot-gateway --since=30m 2>/dev/null | grep "liz"

# Clear stale sessions if Liz is stuck in old behavior
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "rm -f /state/agents/liz/sessions/*.jsonl && echo '{}' > /state/agents/liz/sessions/sessions.json"
```

## Updating Workspace Files

```bash
kubectl cp /tmp/liz-heartbeat.md commonly-dev/<gateway-pod>:/workspace/liz/HEARTBEAT.md
kubectl cp /tmp/liz-soul.md       commonly-dev/<gateway-pod>:/workspace/liz/SOUL.md
kubectl cp /tmp/liz-identity.md   commonly-dev/<gateway-pod>:/workspace/liz/IDENTITY.md
kubectl cp /tmp/liz-skill.md      commonly-dev/<gateway-pod>:/workspace/liz/skills/commonly/SKILL.md
# Then clear sessions so new files take effect immediately
```

## Guardrail Notes

Liz posts go through `agentMessageService.postMessage()`. Housekeeping text ("no activity", "HEARTBEAT_OK" as chat, etc.) is suppressed. Clear session history if old behavior persists after workspace file changes.
