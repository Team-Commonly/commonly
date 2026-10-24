# Task priority, live owner and watchers

TASK-443 · D40 · Design proposal, 2026-10-24 · Owner: Tern

## Behavior

Task.priority is P0, P1, P2 or P3; lower numbers come first and P2 is the default. Create and edit support the field in REST, MCP and the board. Within each status column, order by priority then taskNum, with a stable id tie-breaker. Discovery wakes and assigned-row context use that same ordering before applying limits. An explicit claim by task ID remains deliberate and atomic: priority guides discovery, without denying a human-directed claim of another row. Renewals and existing ownership are never preempted by a new P0.

Cards show a compact P0–P3 badge next to the task ID. The create form and task drawer expose a labelled Priority select. The drawer distinguishes “Assigned to”, “Claimed by”, and “Lease left”. A pending assignment is not a live claim. Claimed cards show the holder and remaining minutes; expiry changes to “Lease expired” without a refresh. Existing socket updates and reconnect fetches remain authoritative. Follow the Signal board artboard and existing tokens; priority is text, not a new color scale.

Task.watchers is a set of User IDs, including human and bot Users. Pod members can follow/unfollow themselves from the drawer; clients cannot subscribe somebody else. The drawer shows the watcher count and names, with “Follow task” / “Following” and explanatory copy: “Updates appear in your digest.” Validate pod access on each write; following does not grant access after membership removal. Repeated follow/unfollow calls are idempotent. Subscription changes do not wake anybody.

Task updates feed agent watchers through deliveryMode=digest, never a watcher-created wake. Existing assignee/claim-holder addressing still works: if a watcher also owns the task, ownership may wake them independently; do not duplicate their digest item. Human watchers get a task-update section in their existing daily digest, filtered by current membership and the digest window. Human watcher updates must not become pending decision/mention attention items or trigger needs-you email. Coalesce repeated edits to one task within a digest window.

## Silent migration

Use a rerunnable direct collection writes for open rows. Copy a leading [P0]–[P3] into priority, strip only that prefix, and set P2 on unprefixed rows lacking a priority. Preserve explicit valid priorities, task IDs, update history, updatedAt and offeredAt. Do not call task routes, taskEventService, model save hooks or AgentEventService. A real-store test records AgentEvent count before/after and proves zero enqueues, no board socket emissions, and unchanged revision timestamps. Run the migration before enabling the new priority readers; legacy writers may remain deployed during it. Report aggregate counts only; do not post or retitle individual rows through the API.

## Implementation boundary and proof

- Data/API: backend/models/Task.ts, backend/routes/tasksApi.ts, packages/types/src/task.ts; add self-follow endpoint and priority validation. Remove the unused shared low/medium/high priority vocabulary.
- Discovery/attention: backend/services/kernelWorkSweepService.ts and taskEventService.ts; dailyDigestService.ts for human watchers, existing AgentEvent digest path for bots. Amend docs/adr/ADR-018-agent-attention-claims.md with priority preference and receive-not-wake rules.
- Agent tools: commonly-mcp/src/tools.js and its tests; trace native task-tool declarations before implementation so all producers accept the same field.
- UI: frontend/src/v2/components/V2PodBoard.tsx, board styles in frontend/src/v2/v2.css, en/zh-CN locale files and V2PodBoard tests. Pin any load-bearing CSS in v2-layout-invariants and verify 1440/390 against UX Lead's artboard.
- Migration: backend/scripts/migrate-task-priority.ts plus service tests. Cover prefixed/unprefixed/explicit priority rows, idempotency and zero events.

Service tests cover concurrent claims retaining one winner; priority ordering before the five-row wake limit; no preemption; watcher authorization/idempotency; digest-only bot events; human digest membership filtering; and no watcher wake or needs-you attention. Gates: CodeRabbit first, Sable code, Rhea wake/security, UX Lead render. Design page plus UX card artboard precede component implementation.
