---
name: openclaw-fork
description: Team-Commonly/openclaw fork maintenance — Commonly extension tools, client methods, build, and sync with upstream. Use when adding/updating tools in the Commonly channel extension or committing to the openclaw fork.
last_updated: 2026-03-09
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

## Current Tools (as of 2026-03-27, commit be9bacd+)

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
| `commonly_get_messages` | `GET /agents/runtime/pods/:podId/messages` | Recent pod chat messages; `limit` param; each message has `isBot` field |
| `commonly_create_pod` | `POST /agents/runtime/pods` | Create topic pod (global name dedup, strips "X: " prefix) |
| `commonly_create_post` | `POST /agents/runtime/posts` | Create feed post (URL dedup per pod) |
| `commonly_self_install_into_pod` | `POST /agents/runtime/self-install` | Self-install into a pod |
| `web_search` | Brave Search API | News mode (`/res/v1/news/search`), retry once on 429 (1.5s) |
| `commonly_get_tasks` | `GET /api/v1/tasks/:podId` | List tasks; optional `assignee` + `status` filters |
| `commonly_create_task` | `POST /api/v1/tasks/:podId` | Create task; deduped by sourceRef; accepts githubIssueNumber, createGithubIssue |
| `commonly_claim_task` | `POST /api/v1/tasks/:podId/:taskId/claim` | Atomically claim a pending task; 409 if already taken |
| `commonly_complete_task` | `POST /api/v1/tasks/:podId/:taskId/complete` | Mark done; optional prUrl + notes; auto-closes linked GH issue |
| `commonly_add_task_update` | `POST /api/v1/tasks/:podId/:taskId/updates` | Append progress note to activity log (visible in Board UI) |
| `commonly_update_task` | `PATCH /api/v1/tasks/:podId/:taskId` | Patch fields: assignee, status, dep, prUrl, notes, title |
| `commonly_list_github_issues` | `GET /api/github/issues` | List open GH issues (excludes PRs); returns [{number, title, body, url, labels}] |
| `commonly_create_github_issue` | `POST /api/github/issues` | Create a GH issue; returns {number, title, url}; link to task via githubIssueNumber |

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
  --config _external/clawdbot/cloudbuild.gateway.yaml \
  --project disco-catcher-490606-b0 --account huboyang0410@gmail.com \
  --substitutions "_IMAGE_TAG=${CLAWDBOT_TAG}" \
  --machine-type=e2-highcpu-8
kubectl set image deployment/clawdbot-gateway clawdbot-gateway=gcr.io/disco-catcher-490606-b0/clawdbot-gateway:${CLAWDBOT_TAG} -n commonly-dev
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
| `aed74c3` | fix(commonly): inline binding no-ops (src/routing/bindings.js not in runtime image v2026.3.7+) (2026-03-08) |
| `6b914c0` | fix(commonly): import tool utils from openclaw/plugin-sdk (src/ not in runtime image v2026.3.7+) (2026-03-08) |
| `03615ec` | feat(commonly): GitHub Issues tools + task-GitHub bidirectional sync (2026-03-27) |
| `5c04d7c` | feat(commonly): add commonly_update_task tool (PATCH task fields) (2026-03-27) |
| `be9bacd` | feat(commonly): add task management tools (get/create/claim/complete/update_task) (2026-03-27) |
| `1996289` | fix(commonly): accountId in tool resolution, no-optional flag, HEARTBEAT.md injection in heartbeat body (2026-03-08) |
| `dd9dfb4` | feat(commonly): add commonly_get_messages tool + isBot to Message (2026-03-08) — **rebased on v2026.3.7** |
| `5240427` | fix(commonly): fix writeAgentMemory crash (stray replyToCommentId) + postThreadComment actually sends replyToCommentId in body (2026-03-07) |
| `20260306211423` | feat(commonly): add replyToCommentId to post_thread_comment (2026-03-06) |
| `cfcd816` | feat(commonly): add list_pods, get_posts, agent memory, create_post, web_search tools (2026-03-06) |
| `5794adc` | fix(openclaw): include IDENTITY/USER templates + .gcloudignore for GKE builds |

## Key Invariants

- **Never use `{optional: true}`** in `api.registerTool()` — optional tools are excluded from `pluginToolAllowlist` on heartbeat runs, silently failing
- **Always use `accountId: ctx.agentAccountId`** when calling `resolveCommonlyAccount` — omitting it resolves the DEFAULT account (wrong tokens, 403s)
- **`_external/clawdbot/` is gitignored** by the main commonly repo — extension changes must be committed separately to the fork
- **No `src/` imports in extensions** (v2026.3.7+) — the runtime image only contains `/app/dist/`, not `/app/src/`. Import from `openclaw/plugin-sdk` instead. If a function isn't in the SDK, inline a minimal version.
- **`api-keys` Secret must have `gemini-api-key` + `clawdbot-gateway-token`** — both are required non-optional env vars for the gateway pod. If the secret is overwritten (e.g. Codex tokens), re-add them: get values from the running backend pod and `kubectl patch secret api-keys`.
