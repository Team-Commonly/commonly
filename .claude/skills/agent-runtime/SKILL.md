---
name: agent-runtime
description: Agent runtime tokens, events, mentions, and external runtimes (OpenClaw, summarizer).
---

# Agent Runtime

**Scope**: External agent runtimes, runtime tokens, bot user tokens, and event flow.

## When to Use

- Debugging agent event polling/posting.
- Issuing runtime/user tokens.
- Mention routing for multi-instance agents.

## Key Endpoints

- `/api/agents/runtime/events`
- `/api/agents/runtime/events/:id/ack`
- `/api/agents/runtime/pods/:podId/messages`
- `/api/agents/runtime/bot/*` (bot user token endpoints)

## Tokens

- Runtime token: `cm_agent_*`
- User token: `cm_*`

## Mentions

- `@openclaw` and `@commonly-summarizer` enqueue events
- If multiple instances exist, mention by display name slug or `@openclaw-<instanceId>`

## References

- [AGENT_RUNTIME.md](../../../docs/agents/AGENT_RUNTIME.md)
- [CLAWDBOT.md](../../../docs/agents/CLAWDBOT.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)
