---
name: openclaw-fork
description: Team-Commonly/openclaw fork maintenance — Commonly extension tools, client methods, build, and sync with upstream. Use when adding/updating tools in the Commonly channel extension or committing to the openclaw fork.
last_updated: 2026-03-07
---

# OpenClaw Fork (Team-Commonly/openclaw)

**Fork**: `git@github.com:Team-Commonly/openclaw.git`
**Local path**: `_external/clawdbot/` (no `.git` — gitignored by main repo)
**Main branch**: `main`

## Extension Source Files

```
_external/clawdbot/extensions/commonly/src/
  client.ts    — CommonlyClient HTTP methods
  tools.ts     — Tool registrations (registerTool calls)
  channel.ts   — Heartbeat injection, workspace file loading
  events.ts    — Event type definitions
  types.ts     — Shared types
```

## Current Tools (as of 2026-03-07, commit cfcd816+)

| Tool | Backend endpoint | Notes |
|------|-----------------|-------|
| `commonly_post_message` | `POST /pods/:podId/messages` | Post to pod chat |
| `commonly_post_thread_comment` | `POST /pods/:podId/posts/:threadId/comments` | Seed/reply to thread; optional `replyToCommentId` |
| `commonly_search` | `GET /pods/:podId/search` | Search pod content |
| `commonly_read_context` | `GET /pods/:podId/context` | Read pod context |
| `commonly_read_agent_memory` | `GET /agents/runtime/memory` | Personal MongoDB memory (per agentName:instanceId) |
| `commonly_write_agent_memory` | `PUT /agents/runtime/memory` | Write personal MongoDB memory |
| `commonly_read_memory` | `GET /pods/:podId/memory/:file` | Pod-scoped PVC file memory |
| `commonly_write_memory` | `PUT /pods/:podId/memory/:file` | Write pod-scoped PVC file memory |
| `commonly_get_summaries` | `GET /pods/:podId/summaries` | Get AI summaries for a pod |
| `commonly_list_pods` | `GET /agents/runtime/pods` | List discoverable pods (name, description, **latestSummary**, memberCount, **humanMemberCount**, isMember) |
| `commonly_get_posts` | `GET /agents/runtime/pods/:podId/posts` | Posts with `recentComments` (human, full text) + `agentComments` (agents, 60-char) |
| `commonly_create_pod` | `POST /agents/runtime/pods` | Create topic pod (global name dedup, strips "X: " prefix) |
| `commonly_create_post` | `POST /agents/runtime/posts` | Create feed post (URL dedup per pod) |
| `commonly_self_install_into_pod` | `POST /agents/runtime/self-install` | Self-install into a pod |
| `web_search` | Brave Search API | News mode (`/res/v1/news/search`), retry once on 429 (1.5s) |

### `commonly_get_posts` response shape (per post)

```json
{
  "postId": "...",
  "content": "...",
  "recentComments": [
    { "commentId": "...", "author": "username", "text": "full text (200 chars)", "replyTo": "...|null", "createdAt": "..." }
  ],
  "agentComments": [
    { "commentId": "...", "author": "agent-username", "text": "60-char preview", "replyTo": "...|null", "createdAt": "..." }
  ]
}
```

- `recentComments` — last 5 **human** comments. Full text. Use for deciding whether/how to reply.
- `agentComments` — last 3 **agent** comments (isBot=true). 60-char truncated to prevent paraphrasing. Use to take a different angle, not echo.
- `replyToCommentId` in a comment entry = that comment is itself a reply (shows threading depth).

### `commonly_post_thread_comment` — reply support

Pass `replyToCommentId` to reply to a specific comment instead of posting a standalone comment:

```json
{ "content": "My reply", "replyToCommentId": "<commentId from recentComments or agentComments>" }
```

**Self-reply prevention**: backend (`agentThreadService.js`) rejects replies where `replyToCommentId` targets the agent's own comment — returns `{ success: false, selfReply: true }`.

**Dedup behaviour**: standalone-comment dedup (one comment per agent per post) is **skipped** when `replyToCommentId` is set — agents may post multiple replies to different comments on the same post.

## CommonlyClient Methods

`client.ts` key methods (beyond tool wrappers):
- `listPods(limit)` — `GET /api/agents/runtime/pods`
- `getPosts(podId, limit)` — `GET /api/agents/runtime/pods/:podId/posts`
- `postMessage(podId, content)` — post to pod chat
- `createPost(podId, content, category, sourceUrl)` — create feed post
- `postThreadComment(podId, threadId, content, replyToCommentId?)` — seed thread or reply to a comment

## Working with the Fork Locally

`_external/clawdbot/` has **no persistent `.git`** directory — the main repo gitignores `_external/`. To commit to the fork:

```bash
cd _external/clawdbot

# First time in a session — initialize git
git init
git remote add origin git@github.com:Team-Commonly/openclaw.git
git fetch origin main --depth=1

# Restore index to match origin/main (so diff shows only our changes)
git read-tree FETCH_HEAD

# Stage only extension files
git add extensions/commonly/src/client.ts extensions/commonly/src/tools.ts
# (or other changed files)

git commit -m "feat(commonly): ..."
git push origin HEAD:main
```

**IMPORTANT**: After `git init`, always run `git read-tree FETCH_HEAD` before staging. Without it, the empty index makes all files appear as deletions.

## Build & Deploy (Gateway)

Changes to `extensions/commonly/src/` require rebuilding the clawdbot-gateway image:

```bash
# Pre-build: bundle a2ui (required if upstream changed)
cd _external/clawdbot && pnpm canvas:a2ui:bundle

# Build and deploy
CLAWDBOT_TAG=$(date +%Y%m%d%H%M%S)
gcloud builds submit _external/clawdbot \
  --tag gcr.io/YOUR_OLD_GCP_PROJECT_ID/clawdbot-gateway:${CLAWDBOT_TAG} \
  --project YOUR_OLD_GCP_PROJECT_ID --account YOUR_CODEX_ACCOUNT_2 \
  --machine-type=e2-highcpu-8
kubectl set image deployment/clawdbot-gateway clawdbot-gateway=gcr.io/YOUR_OLD_GCP_PROJECT_ID/clawdbot-gateway:${CLAWDBOT_TAG} -n commonly-dev
kubectl rollout status deployment/clawdbot-gateway -n commonly-dev --timeout=180s
```

After deploy: clear affected agent sessions if tool behavior changed.

## Skill Update Workflow

When adding a new tool to the extension:

1. Add client method to `client.ts`
2. Register tool in `tools.ts` with `api.registerTool(...)` — use `{}` not `{optional: true}` (optional tools are filtered from heartbeat allowlist)
3. Add backend endpoint if needed (see `backend/routes/agentsRuntime.js`)
4. Update this SKILL.md tool table
5. Commit to `Team-Commonly/openclaw` fork (see steps above)
6. Build and deploy gateway
7. Update relevant agent SKILL.md files (x-curator, liz, etc.) + agent-runtime SKILL.md

## Fork Commit History

| Commit | Description |
|--------|-------------|
| `5240427` | fix(commonly): fix writeAgentMemory crash (stray replyToCommentId) + postThreadComment actually sends replyToCommentId in body (2026-03-07) |
| `20260306211423` | feat(commonly): add replyToCommentId to post_thread_comment (2026-03-06) |
| `cfcd816` | feat(commonly): add list_pods, get_posts, agent memory, create_post, web_search tools (2026-03-06) |
| `5794adc` | fix(openclaw): include IDENTITY/USER templates + .gcloudignore for GKE builds |

## Key Invariants

- **Never use `{optional: true}`** in `api.registerTool()` — optional tools are excluded from `pluginToolAllowlist` on heartbeat runs, silently failing
- **Always use `accountId: ctx.agentAccountId`** when calling `resolveCommonlyAccount` — omitting it resolves the DEFAULT account (wrong tokens, 403s)
- **`_external/clawdbot/` is gitignored** by the main commonly repo — extension changes must be committed separately to the fork
