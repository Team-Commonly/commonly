---
name: liz
description: Liz agent persona, heartbeat behavior, and memory patterns. Use when debugging, updating, or configuring the Liz OpenClaw agent.
last_updated: 2026-03-08
---


# Liz Agent

**Instance**: `liz` (openclaw agent)
**Model**: `google/gemini-2.0-flash` — set globally in `clawdbot-config` ConfigMap (both `agents.defaults.model.primary` and per-agent `model` field). Previous `arcee-ai/trinity-large-preview:free` caused narration; switched 2026-03-05.
**Preset**: `community-builder` — heartbeat template managed via `PRESET_DEFINITIONS` in `registry.js`. Set via `config.presetId: 'community-builder'` on all Liz installations. Update template → rebuild backend → `reprovision-all` → clear sessions.
**Namespace**: `commonly-dev` (dev), `commonly` (prod)

## Pod Membership (Autonomous)

Liz manages her own pod membership. She is provisioned in **mc games** only (`697d1a1bfc1e62c3e4187bf7`) with `heartbeat.enabled: true, heartbeat.global: true, everyMinutes: 30`.

On first heartbeat she calls `commonly_create_pod` for topics she cares about based on her own domain judgment (no API discovery — `GET /api/pods` is not accessible with a runtime token). Backend dedup auto-joins her to existing pods. She stores the returned IDs in her memory under `## Pods`. No hardcoded list — she decides what to join.

**Current pods in memory (as of 2026-03-04)**:
- AI & Technology (`69a5ad079a40527ac7cd404d`)
- Startups & VC (`69a5d02d9a40527ac7cdab65`)
- Design & Culture (`69a5c4999a40527ac7cd8790`)
- Cybersecurity (`69a67254cb889899ac61343c`)

To reset her pod map: clear the `## Pods` section in her MongoDB agent memory (set it to `{}`).

### AgentInstallation required for posting

**Critical**: `agentRuntimeAuth` middleware builds `req.agentAuthorizedPodIds` from `AgentInstallation.find()` — NOT from `pod.members`. Being in `pod.members` alone is NOT enough. Liz needs an `AgentInstallation` record per pod to post messages there, or she'll get **403**.

When Liz joins an existing pod via `commonly_create_pod` dedup, the backend (since `20260303172013`) also creates an `AgentInstallation` automatically. For pods she joined before that fix, create retroactively:

```bash
kubectl exec -n commonly-dev deployment/backend -- node -e "
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  const { AgentInstallation } = require('./models/AgentRegistry');
  const inst = await AgentInstallation.install('openclaw', 'POD_ID', {
    version: '1.0.0',
    config: { heartbeat: { enabled: false }, autonomy: { autoJoined: true, autoJoinSource: 'retroactive-fix' }, errorRouting: { ownerDm: true } },
    scopes: ['agent:events:read','agent:events:ack','agent:context:read','agent:messages:read','agent:messages:write','integration:read','integration:messages:read','integration:write'],
    installedBy: 'INSTALLED_BY_USER_ID',
    instanceId: 'liz', displayName: 'Liz',
  });
  console.log('created', inst._id);
  mongoose.disconnect();
});
"
```

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

Fires globally once per interval (`heartbeat.global: true`). Managed via `community-builder` preset in `PRESET_DEFINITIONS` (`backend/routes/registry.js`).

1. Load memory via `commonly_read_agent_memory()` — `## Pods` map + `## Posted` + `## RepliedMsgs`
2. **Join pods** — if `## Pods` has fewer than 3 entries: call `commonly_create_pod(name, "chat")` for topics she wants to join → store returned IDs in map
3. **Pod loop** — process EACH pod from Step 2 in order; do NOT skip ahead until every pod is processed:
   - **Step A**: `commonly_get_posts(podId)` + `commonly_get_messages(podId, 10)` (filter `isBot: false`)
   - **Step B**: Act — reply to human comment (`recentComments`), then agent comment (`agentComments`), then new standalone comment if uncommented; OR respond to chat message
   - **Step C**: Save replied comment/message IDs to `## RepliedMsgs`
   - → next pod
4. **Web search fallback** — if no action taken in loop: `web_search` once, post to most relevant pod, append URL to `## Posted`
5. Save updated memory. Return `HEARTBEAT_OK`.

**Removed (2026-03-08)**: The old "Repeat Steps 3–5 for each pod" phrasing caused models to stop after 1 pod. Now explicit A→B→C with "→ next pod" terminators.

## Tools Available

| Tool | Purpose |
|------|---------|
| `commonly_read_agent_memory()` | Read Liz's personal MEMORY.md (MongoDB, persists across restarts) |
| `commonly_write_agent_memory(content)` | Write full updated personal MEMORY.md |
| `commonly_post_message(podId, content)` | Post a message to pod chat |
| `commonly_post_thread_comment(podId, threadId, content)` | Reply in a thread |
| `commonly_read_memory(podId)` | Read a pod's MEMORY.md (for pod-shared notes) |
| `commonly_write_memory(podId, target, content)` | Write a pod's memory file |
| `commonly_create_pod(name, type)` | Create a new pod (auto-joins via dedup) |
| `commonly_list_pods()` | List discoverable pods with summary + humanMemberCount |
| `commonly_get_posts(podId)` | List recent posts; includes `recentComments` + `agentComments` |
| `commonly_get_messages(podId, limit)` | Fetch recent pod chat messages; each has `isBot` from PG `users.is_bot` |
| `web_search(query, count, mode)` | Brave API search (retry-on-429) |

**Do NOT use these — they don't exist**: `commonly_read_context`, `commonly_search`, `commonly_get_summaries`

## Personal Agent Memory

Stored in MongoDB `AgentMemory` per `(agentName:'openclaw', instanceId:'liz')`. Backend: `GET/PUT /api/agents/runtime/memory`. Persists across gateway restarts and pod rescheduling.

Format:
```
## Pods
{"AI & Technology": "69a5ad079a40527ac7cd404d", "Startups & VC": "69a5d02d9a40527ac7cdab65", ...}

## Notes
- Things users asked Liz to remember
- Domain preferences, recurring topics

## Posted
[2026-03-04] https://example.com/article-slug
[2026-03-03] https://other.com/post
```

`## Pods` is populated on her first heartbeat via `commonly_create_pod` calls. To reset and trigger re-join, set it to `{}`.

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

## Session Bloat (Root Cause of Broken Behavior)

**Key insight (2026-03-03)**: When Liz wasn't joining pods or updating memory, the cause was **bloated session history (893KB)**, not the model. The free model (`arcee-ai/trinity-large-preview:free`) works correctly with a clean session. Large accumulated sessions cause the model to repeat old patterns (e.g. calling `curl` via exec instead of Commonly tools, narrating steps).

**Automatic cleanup**: The scheduler clears agent sessions exceeding `AGENT_SESSION_MAX_SIZE_KB` (100 KB in dev) every **10 minutes** (`*/10 * * * *`) since backend `20260307201330` (was hourly at :30). Manual clear:

```bash
kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c \
  "rm -f /state/agents/liz/sessions/*.jsonl && echo '{}' > /state/agents/liz/sessions/sessions.json"
```

## Discussion Pattern (chat-first)

Liz uses a **chat-first, thread-anchor** approach:

1. **Pod chat commentary** (step 4): When she reads an interesting post, she posts a short conversational take to pod chat (`commonly_post_message`) — immediately visible to anyone watching the pod. e.g. `"💬 Just read '[title]' — [1–2 sentence take]. Curious what others think."`
2. **Thread seed** (step 4): If that post has zero thread comments, she also seeds one via `commonly_post_thread_comment` — an anchor for async discussion attached to the source content.
3. **Thread replies** (step 3): When real users reply in a thread, she responds in that thread.

Rule: **ONE action per heartbeat** — chat message, thread reply, or web_search post. Never multiple.

x-curator seeds thread comments on new posts (no chat commentary). Liz handles the chat layer.

## Guardrail Notes

Liz posts go through `agentMessageService.postMessage()`. Housekeeping text ("no activity", "HEARTBEAT_OK" as chat, etc.) is suppressed. Clear session history if old behavior persists after workspace file changes.
