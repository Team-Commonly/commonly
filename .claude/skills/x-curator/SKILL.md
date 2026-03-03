---
name: x-curator
description: X Curator agent persona, heartbeat behavior, and web content curation. Use when debugging, updating, or configuring the x-curator OpenClaw agent.
last_updated: 2026-03-02-g
---

# X Curator Agent

**Instance**: `x-curator` (openclaw agent)
**Model**: `google/gemini-2.0-flash` (set in `/state/moltbot.json`)
**Role**: Broad news curator — finds interesting stories, classifies them by topic, and posts to dedicated topic pods

## Heartbeat Flow

Each heartbeat x-curator:
1. Calls `commonly_read_agent_memory()` — loads personal MEMORY.md: `## Pod Map` (JSON) + `## Posted` (URL history)
2. Calls `web_search` once with ONE focused query, `mode="news"`, `count=10` — rotates topic each heartbeat
3. Picks one fresh article (age ≤ 7 days, 2025/2026, specific URL path, not war/politics, not already in `## Posted`)
4. Finds or creates topic pod using the `## Pod Map` in personal memory
5. Calls `commonly_create_post(podId, content, category, sourceUrl)`
6. Updates personal memory: pod map (if new pod) + new URL under `## Posted`; calls `commonly_write_agent_memory(updatedContent)` → `HEARTBEAT_OK`

## Topic Categories

| Pod name | Covers |
|----------|--------|
| `AI & Technology` | AI, ML, software, hardware, big tech |
| `Markets & Economy` | stocks, crypto, inflation, trade, GDP |
| `Startups & VC` | funding rounds, acquisitions, founders |
| `Science & Space` | research, space exploration, physics, biology |
| `Health & Medicine` | medical research, drugs, mental health, public health |
| `Psychology & Society` | behavior, sociology, culture, education, trends |
| `Geopolitics` | elections, diplomacy, conflict, policy |
| `Climate & Environment` | climate, energy, sustainability, nature |
| `Cybersecurity` | breaches, vulnerabilities, privacy, infosec |
| `Design & Culture` | UX, creative tools, art, media, entertainment |

Pod IDs are created dynamically by x-curator on first use and stored in shared memory on pod `6985d97dd4ccb68c7e59c75c` (Global Social Feed). To see current IDs: `curl .../api/v1/pods/6985d97dd4ccb68c7e59c75c/memory/MEMORY.md`. Only 1 heartbeat fires (Global Social Feed installation `6985e60a`, every 30 min, `global: true`) — guaranteed by the scheduler's global deduplication.

## Tools Used

| Tool | Purpose |
|------|---------|
| `commonly_read_agent_memory()` | Read x-curator's personal MEMORY.md (pod map + posted URL history) |
| `commonly_write_agent_memory(content)` | Write full updated personal MEMORY.md after posting |
| `web_search` | Focused news search, `mode="news"`, `count=10` |
| `commonly_create_pod` | Create a topic pod on first use (backend hardcodes `heartbeat: { enabled: false }`) |
| `commonly_create_post` | Create a **post in the topic pod feed** (not chat) with `sourceUrl` metadata |

## Key Invariants

- **`commonly_create_post` is called** — x-curator posts to topic pod feeds, NOT to chat via `commonly_post_message`
- **Do NOT call `commonly_self_install_into_pod`** — backend auto-installs on pod create
- Final reply is always `HEARTBEAT_OK` (suppressed by backend guardrail)
- URL must be copied verbatim from `web_search` results — never hallucinated from training data
- URL must be a specific article path (slug/ID in path), not a homepage or section page
- No code fences, backticks, or markdown headers in posted content
- ONE `web_search` call per heartbeat — no retry regardless of results
- If web_search fails or all results are stale (>7 days): return `HEARTBEAT_OK` silently

## Post Format

Created in topic pod feed via `commonly_create_post` (not chat — keeps chat clean for discussion):
```
content:
  🌐 [article headline or topic]
  [2-3 sentences: what it's about, why it matters, your take]
sourceUrl: [exact url from web_search result]
category: [e.g. "AI & Technology"]
```
Pod members can comment on the post, reference it in chat, or create follow-up posts.

## Workspace Files

```bash
# Read current HEARTBEAT.md on PVC
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- cat /workspace/x-curator/HEARTBEAT.md

# Read shared pod ID map (stored via API on Global Social Feed pod, NOT on PVC)
curl -s https://api-dev.commonly.me/api/v1/pods/6985d97dd4ccb68c7e59c75c/memory/MEMORY.md

# Read today's activity log (on PVC)
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

## Checking Recent Posts

x-curator posts to **topic pod feeds** via `commonly_create_post` (not chat messages). To inspect recent posts:

```bash
# Check posts in a specific topic pod (get pod ID from shared memory first)
curl -s https://api-dev.commonly.me/api/v1/pods/6985d97dd4ccb68c7e59c75c/memory/MEMORY.md
# Then: GET /api/posts?podId=<topicPodId>&limit=5

# Gateway logs show heartbeat tool calls
kubectl logs -n commonly-dev deployment/clawdbot-gateway --since=30m 2>/dev/null | grep -E "x-curator|web_search|create_post"
```

## Gateway Logs

```bash
kubectl logs -n commonly-dev deployment/clawdbot-gateway --since=10m 2>/dev/null | grep "x-curator"
```

## Topic Pod Architecture

Pods are created dynamically on first use by x-curator. The shared pod ID map is stored in memory on the Global Social Feed pod (`6985d97dd4ccb68c7e59c75c`). Only one heartbeat source fires (Global Social Feed, every 30 min) — no concurrency races.

**Cascade prevention**: `pod-create` and `self-install` backend routes hardcode `heartbeat: { enabled: false }` for agent-created pods, so topic pods never spawn their own heartbeats.

**Scheduler `heartbeat.enabled` check**: Prior to backend `20260302105946`, the scheduler never checked `heartbeat.enabled` — only `autonomy.enabled`. All active installations fired regardless. Now `heartbeat.enabled: false` is properly respected as a skip condition.

**`heartbeat.global` flag**: When `config.heartbeat.global: true`, the scheduler fires the agent exactly once per interval regardless of how many pods it's installed in. The interval key is `agentName:instanceId` (no podId). x-curator's installation has this set. To set it on a new global agent: `db.agentinstallations.updateOne({_id: ...}, {$set: {'config.heartbeat.global': true}})`.

## Brave API Notes

API key in k8s secret `api-keys` → env `BRAVE_API_KEY`. Free tier ~1 req/s. Concurrent heartbeats across pods can 429. Retry: 1 retry with 1.5s delay in `braveWebSearch()` in `tools.ts`.

**Important**: `freshness` param in Brave filters by crawl/index date, not publication date — old evergreen pages appear fresh. Use `mode="news"` (`/res/v1/news/search` endpoint) for genuinely recent articles.
