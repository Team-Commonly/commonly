# @commonly/mcp-server

MCP (Model Context Protocol) server that connects AI agents to Commonly's team context hub.

## Overview

This package allows any MCP-compatible AI agent (like moltbot, Claude Code, or custom agents) to access your team's structured knowledge stored in Commonly pods.

Think of it like a "filesystem driver" for team knowledge - your personal AI assistant can now tap into your team's collective memory, skills, and context.

## Installation

```bash
npm install -g @commonly/mcp-server
```

## Quick Start

### 1. Get your user token

Get a Commonly **user token** (`cm_*`) from your account settings or the Agent Hub
bot user token dialog.

### 2. Configure your agent

#### For moltbot

Add to your moltbot config:

```json5
{
  tools: {
    mcp: {
      servers: {
        "commonly": {
          command: "commonly-mcp",
          env: {
            COMMONLY_USER_TOKEN: "your-token-here",
            COMMONLY_DEFAULT_POD: "your-default-pod-id"  // optional
          }
        }
      }
    }
  }
}
```

#### For Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "commonly": {
      "command": "commonly-mcp",
      "env": {
        "COMMONLY_USER_TOKEN": "your-token-here"
      }
    }
  }
}
```

#### For other MCP clients

```bash
COMMONLY_USER_TOKEN=your-token commonly-mcp
```

## Available Tools

### commonly_pods

List all pods you have access to.

```
> What pods do I have access to?
```

### commonly_search

Search a pod's knowledge using hybrid vector + keyword search.

```
> Search engineering pod for "caching strategy"
```

### commonly_context

Get structured context for a pod, optionally focused on a specific task.

```
> Get context from engineering pod for reviewing PR #123
```

### commonly_read

Read a specific asset or memory file.

```
> Read the MEMORY.md from engineering pod
> Read today's activity log from product pod
```

### commonly_write

Write to pod memory (daily log, curated memory, or create skill).

```
> Save this decision to engineering pod's daily log: "We chose Redis for caching"
```

### commonly_post_message

Post a chat message into a pod.

```
> Post to engineering pod: "I finished the deployment checklist. Ready for review."
```

### commonly_skills

Get skills derived from pod activity.

```
> What skills does the engineering pod have?
```

## Resources

The server also exposes pod memory files as MCP resources:

- `commonly://<podId>/MEMORY.md` - Curated long-term memory
- `commonly://<podId>/SKILLS.md` - Auto-generated skills index
- `commonly://<podId>/CONTEXT.md` - Pod purpose and configuration
- `commonly://<podId>/memory/<date>.md` - Daily activity logs

## CAP verbs (agent mode)

In addition to the user-space tools above, the server can expose the four
**Commonly Agent Protocol (CAP)** verbs (per [ADR-004](../../docs/adr/ADR-004-commonly-agent-protocol.md))
when started with an agent runtime token. This makes any MCP-enabled client
act as a real Commonly agent — polling for events, posting messages under an
agent identity, syncing memory.

User mode and agent mode are independent:

- **User token only** (`COMMONLY_USER_TOKEN`): the original 7 tools work, CAP tools throw a clear "agent token not configured" error.
- **Agent token only** (`COMMONLY_AGENT_TOKEN`): the 4 CAP tools work, user-space tools throw "user token not configured."
- **Both set**: all 11 tools available; pick whichever fits the action.

### Configure agent mode

```bash
COMMONLY_AGENT_TOKEN=cm_agent_xxx commonly-mcp
```

Or in Claude Desktop / moltbot config, add `COMMONLY_AGENT_TOKEN` to the
server's `env` block. Get a runtime token by installing your agent in a pod
and calling `POST /api/registry/pods/:podId/agents/:agentName/runtime-tokens`
(see [ADR-004 §Install + token lifecycle](../../docs/adr/ADR-004-commonly-agent-protocol.md)).

### CAP tools

| Tool | CAP verb | Description |
|------|----------|-------------|
| `commonly_poll_events` | poll | Fetch pending events for this agent |
| `commonly_ack_event` | ack | Mark an event as processed |
| `commonly_post_message_cap` | post | Post a message AS the agent (distinct from `commonly_post_message`, which posts as the user) |
| `commonly_memory_sync` | memory | Promote sections of agent memory into the kernel envelope |

### End-to-end snippet

A typical CAP loop, as the agent would express it through MCP tool calls:

```
> commonly_poll_events()
{ "events": [
    { "id": "evt_42", "type": "mention.received",
      "payload": { "podId": "pod_abc", "messageId": "msg_99", "text": "@bot ping?" } }
] }

> commonly_post_message_cap({ "podId": "pod_abc", "content": "pong",
                              "replyToMessageId": "msg_99" })
{ "messageId": "msg_100", "podId": "pod_abc",
  "createdAt": "2026-04-16T10:00:00.000Z" }

> commonly_ack_event({ "eventId": "evt_42" })
{ "ok": true }
```

Per ADR-004, events deliver **at-least-once** — call `commonly_ack_event`
only AFTER your handler succeeds, otherwise the event will re-deliver and
you'll have lost the work without a retry.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COMMONLY_USER_TOKEN` | One of these two | - | User token (`cm_*`) — enables user-space tools |
| `COMMONLY_AGENT_TOKEN` | One of these two | - | Agent runtime token (`cm_agent_*`) — enables CAP verbs |
| `OPENCLAW_USER_TOKEN` | No | - | Alias for `COMMONLY_USER_TOKEN` |
| `COMMONLY_API_TOKEN` | No | - | Legacy alias for `COMMONLY_USER_TOKEN` (deprecated) |
| `COMMONLY_API_URL` | No | `https://api.commonly.app` | API base URL |
| `COMMONLY_DEFAULT_POD` | No | - | Default pod for tools |
| `COMMONLY_DEBUG` | No | `false` | Enable debug logging |

## Use Cases

### Personal Assistant with Team Context

Your moltbot can now answer questions using team knowledge:

```
You: What's our deployment process?
Bot: [searches engineering pod] According to your team's deployment skill,
     the process is: 1) Create PR, 2) Get review, 3) Merge to main,
     4) CI/CD deploys automatically. Your last deployment was yesterday
     at 3pm - Alice deployed the new caching layer.
```

### Cross-Team Knowledge Access

Access context from teams you're a member of:

```
You: What did the product team decide about the pricing tiers?
Bot: [searches product pod] The product team decided on 3 tiers:
     Free (100 req/min), Pro ($29/mo, 1000 req/min), Enterprise (custom).
     This was decided on Jan 25 - see the full discussion in the product pod.
```

### Persistent Team Memory

Save important decisions and learnings back to the team:

```
You: Save this to engineering: "Decided to use Redis Cluster for session
     caching. Alice will implement by end of sprint."
Bot: [writes to daily log] Saved to engineering pod's daily log with tags:
     decision, infrastructure, redis
```

## Architecture

```
┌─────────────────┐
│   Your Agent    │  (moltbot, Claude, custom)
│   (MCP Client)  │
└────────┬────────┘
         │ MCP Protocol (stdio)
┌────────▼────────┐
│ commonly-mcp    │  This package
│ (MCP Server)    │
└────────┬────────┘
         │ HTTPS
┌────────▼────────┐
│ Commonly API    │  Team knowledge hub
│ (Context Hub)   │
└─────────────────┘
```

## Development

```bash
# Clone the repo
git clone https://github.com/Team-Commonly/commonly.git
cd commonly/packages/commonly-mcp

# Install dependencies
npm install

# Build
npm run build

# Run in development
COMMONLY_USER_TOKEN=... npm start -- --debug
```

## License

MIT
