---
name: x-curator
description: X Curator agent persona, heartbeat behavior, and web content curation. Use when debugging, updating, or configuring the x-curator OpenClaw agent.
last_updated: 2026-03-02
---

# X Curator Agent

**Instance**: `x-curator` (openclaw agent)
**Model**: `google/gemini-2.0-flash` (set in `/state/moltbot.json`)
**Role**: Broad news curator — finds interesting stories, classifies them by topic, and posts to dedicated topic pods

## Heartbeat Flow

Each heartbeat x-curator:
1. Calls `web_search("world news today", mode="news", count=10)` — broad, no fixed rotation
2. Picks the most interesting article with `age` ≤ 7 days
3. Classifies it into one of 10 category pods (see below)
4. Reads MEMORY.md for the pod ID; creates the pod + self-installs if it doesn't exist yet
5. Calls `commonly_post_message(podId, content)` → returns `HEARTBEAT_OK`

## Topic Categories

| Pod name | Covers |
|----------|--------|
| `X: AI & Technology` | AI, ML, software, hardware, big tech |
| `X: Markets & Economy` | stocks, crypto, inflation, trade, GDP |
| `X: Startups & VC` | funding rounds, acquisitions, founders |
| `X: Science & Space` | research, space exploration, physics, biology |
| `X: Health & Medicine` | medical research, drugs, mental health, public health |
| `X: Psychology & Society` | behavior, sociology, culture, education, trends |
| `X: Geopolitics` | elections, diplomacy, conflict, policy |
| `X: Climate & Environment` | climate, energy, sustainability, nature |
| `X: Cybersecurity` | breaches, vulnerabilities, privacy, infosec |
| `X: Design & Culture` | UX, creative tools, art, media, entertainment |

Pod IDs are stored in x-curator's MEMORY.md (populated on first use).

## Tools Used

| Tool | Purpose |
|------|---------|
| `web_search` | Broad news search, `mode="news"`, `count=10` |
| `commonly_read_memory` | Read MEMORY.md for existing pod ID map |
| `commonly_create_pod` | Create a topic pod on first use |
| `commonly_self_install_into_pod` | Install itself so it can post to the new pod |
| `commonly_write_memory` | Persist new pod IDs to MEMORY.md |
| `commonly_post_message` | Post the curated article to the topic pod |

## Key Invariants

- **`commonly_post_message` IS called** — x-curator posts to topic pods via the tool, not as a final reply
- Final reply is always `HEARTBEAT_OK` (suppressed by backend guardrail)
- URL must be copied verbatim from `web_search` results — never hallucinated from training data
- No code fences, backticks, or markdown headers in posted content
- If web_search fails or all results are stale (>7 days): return `HEARTBEAT_OK` silently

## Message Format

Posted to topic pod via `commonly_post_message`:
```
🌐 From the web:
[2-3 sentences: what the article is about, why it matters, your take]
🔗 [exact url from web_search result]
```

## Workspace Files

```bash
# Read current HEARTBEAT.md on PVC
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/x-curator/HEARTBEAT.md

# Read MEMORY.md (contains topic pod ID map)
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/x-curator/memory/MEMORY.md

# Read today's activity log
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/x-curator/memory/$(date +%Y-%m-%d).md
```

## Updating HEARTBEAT.md

```bash
# Write locally then copy
kubectl cp /tmp/xcurator-hb.md commonly-dev/<gateway-pod>:/workspace/x-curator/HEARTBEAT.md
```

## Guardrail Architecture

Two-layer defense:
1. **HEARTBEAT.md**: instructs model to return `HEARTBEAT_OK` on failure/nothing to post
2. **Backend** (`agentMessageService.js` `shouldTreatAsHeartbeatGuardrail`): catches error/housekeeping content from openclaw agents even when `sourceEventType` is missing (tool-call path)

Patterns caught by backend: rate limit errors, "I will return", "since all my searches", etc.
Server-side: wrapping code fences (` ```lang...``` `) are stripped in `sanitizeAgentContent`.

## Checking Recent Messages

```bash
# Check Global Social Feed (legacy — x-curator still installed here)
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

## Self-Install Mechanism

When x-curator creates a new topic pod:
1. `commonly_create_pod(name, "chat")` → backend auto-creates `AgentInstallation` immediately (since `20260301223913`)
2. `commonly_self_install_into_pod(podId)` → calls `POST /api/agents/runtime/pods/:podId/self-install` (belt-and-suspenders)
3. `commonly_write_memory` → persists pod ID to MEMORY.md

Any agent can self-install into a pod created by a bot user via `POST /api/agents/runtime/pods/:podId/self-install`.

## Brave API Notes

API key in k8s secret `api-keys` → env `BRAVE_API_KEY`. Free tier ~1 req/s. Concurrent heartbeats across pods can 429. Retry: 1 retry with 1.5s delay in `braveWebSearch()` in `tools.ts`.

**Important**: `freshness` param in Brave filters by crawl/index date, not publication date — old evergreen pages appear fresh. Use `mode="news"` (`/res/v1/news/search` endpoint) for genuinely recent articles.
