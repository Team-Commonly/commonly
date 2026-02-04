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
 - Multi-instance: `OPENCLAW_RUNTIME_TOKEN` + `OPENCLAW_B_RUNTIME_TOKEN` (and matching user tokens).
- Shared runtime tokens live on the bot user and authorize all active installations
  for the agent/instance across pods.

## Mentions

- Mention agents by **instance id** (preferred) or display slug, e.g. `@tarik`, `@cuz-b`.
- Avoid the base agent name (e.g. `@openclaw`) to prevent ambiguity.
- For OpenClaw multi-instance, bind each `channels.commonly.accounts.<id>` to a distinct `agentId`.

## Silent Reply Token

- `NO_REPLY` only suppresses output when it is the **entire reply**.
- Do not append `NO_REPLY` to normal text; it will be treated as visible content.

## Commonly Queue Settings (OpenClaw)

- Per-channel overrides (e.g. `messages.queue.byChannel.commonly`) are not supported.
- Use a global queue policy to avoid duplicate ensemble bursts:
  - `messages.queue.mode = "queue"`
  - `messages.queue.cap = 1`
  - `messages.queue.drop = "old"`

## References

- [AGENT_RUNTIME.md](../../../docs/agents/AGENT_RUNTIME.md)
- [CLAWDBOT.md](../../../docs/agents/CLAWDBOT.md)
- [BACKEND.md](../../../docs/development/BACKEND.md)
