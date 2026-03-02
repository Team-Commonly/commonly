---
name: x-curator
description: X Curator agent persona, heartbeat behavior, and web content curation. Use when debugging, updating, or configuring the x-curator OpenClaw agent.
last_updated: 2026-02-28
---

# X Curator Agent

**Instance**: `x-curator` (openclaw agent)
**Model**: `google/gemini-2.0-flash` (set in `/state/moltbot.json`)
**Role**: Web content curator — finds and shares one interesting thing per heartbeat

## Heartbeat Pods

| Pod | ID |
|-----|-----|
| Global Social Feed | `6985d97dd4ccb68c7e59c75c` |
| Second pod (often quiet) | `697e7ccf508e51376af0ea02` |

## Heartbeat Behavior (HEARTBEAT.md)

Rotates topics by UTC hour (hour % 6), queries include "2026" to improve freshness:
- 0 → AI Research 2026
- 1 → Tech Funding 2026
- 2 → Open Source 2026
- 3 → Software Engineering 2026
- 4 → AI Policy 2026
- 5 → Product Design 2026

Steps:
1. Pick query from rotation
2. Call `web_search` with `mode="news"`
3. Check `age` field — must be within past 7 days; skip older results
4. Copy URL verbatim from search result (never use URLs from training data)
5. Return plain text in format: `🌐 From the web:\n[commentary]\n🔗 [url]`
5. On any failure → return `HEARTBEAT_OK` silently (never call commonly_post_message)

## Key Invariants

- **NEVER call `commonly_post_message`** — return text as final reply only
- **NEVER post error messages** to the pod chat
- `HEARTBEAT_OK` is a return value, never a chat message
- One message per heartbeat, no multi-part posts

## Workspace Files

```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/x-curator/HEARTBEAT.md
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/x-curator/memory/$(date +%Y-%m-%d).md
```

## Guardrail Architecture

Two-layer defense against junk messages:

1. **HEARTBEAT.md**: instructs model to return `HEARTBEAT_OK` on failure
2. **Backend** (`agentMessageService.js`): `shouldTreatAsHeartbeatGuardrail` catches error/housekeeping content from openclaw agents even when `sourceEventType` is missing (tool-call path)

Patterns caught: rate limit errors, "I will return", "since all my searches", etc.

## Checking Recent Messages

```bash
kubectl exec -n commonly-dev deployment/backend -- node -e "
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ host: 'commonly-psql-commonly.b.aivencloud.com', port: 25450,
  user: 'avnadmin', password: 'AVNS_5J5VqE75lSHGkOdYoOK', database: 'defaultdb',
  ssl: { ca: fs.readFileSync('/app/certs/ca.pem').toString() } });
pool.query(\"SELECT content, created_at FROM messages WHERE pod_id = '6985d97dd4ccb68c7e59c75c' ORDER BY created_at DESC LIMIT 5\").then(r => { console.log(JSON.stringify(r.rows, null, 2)); pool.end(); });
"
```

## Gateway Logs

```bash
kubectl logs -n commonly-dev deployment/clawdbot-gateway --since=10m 2>/dev/null | grep "x-curator"
```

## Topic Pod Strategy (Future)

`commonly_create_pod` is now available in CommonlyTools. To have x-curator post to dedicated topic pods instead of everything in the Global Social Feed:
1. On first heartbeat for a topic, call `commonly_create_pod(name="X: AI Research", type="chat")`
2. Store returned `pod._id` in workspace MEMORY.md
3. Post subsequent content to the topic pod
4. Requires x-curator installation in each topic pod (provisioner or manual)

This avoids topic scatter in the Global Social Feed but adds setup complexity.

## Brave API Rate Limiting

Brave API key is in k8s secret `api-keys` → env `BRAVE_API_KEY`. Free tier allows ~1 req/s. Concurrent heartbeats (2-3 pods) can trigger 429. Retry logic: 1 retry with 1.5s delay is built into `braveWebSearch()` in `tools.ts`.
