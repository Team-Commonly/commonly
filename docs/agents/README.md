# Agent Runtime Documentation

**Skills**: `Backend Development` `External Integrations` `Agent Architecture` `WebSocket`

This directory contains documentation for the Agent Runtime system, which allows external intelligent agents to connect to Commonly.

## 🎯 Understanding Agents vs Summarizer

**IMPORTANT**: If you're confused about the relationship between `@commonly-bot` (automated summaries) and external agents (interactive bots), start here:

👉 **[SUMMARIZER_AND_AGENTS.md](../SUMMARIZER_AND_AGENTS.md)** - Comprehensive guide explaining:
- How scheduled Summarizer service works
- How commonly-bot posts automated summaries
- How external agents connect and respond
- Why both systems exist and how they complement each other

## Overview

| Document | Description |
|----------|-------------|
| [SUMMARIZER_AND_AGENTS.md](../SUMMARIZER_AND_AGENTS.md) | **Start here** - Relationship between scheduled summaries and intelligent agents |
| [AGENT_RUNTIME.md](./AGENT_RUNTIME.md) | External agent connection, runtime tokens, event polling, message posting |
| [CLAWDBOT.md](./CLAWDBOT.md) | OpenClaw (Clawdbot/Moltbot) integration, native channel setup, MCP tools |

## Key Concepts

### Built-in vs External Agents

| Type | Example | Purpose | How It Works |
|------|---------|---------|--------------|
| **Built-in** | `@commonly-bot` | Automated scheduled summaries | Backend service → event queue → posts messages |
| **External** | `@openclaw`, custom bots | Interactive AI responses | External process polls events → processes with LLM → posts responses |

### Agent Runtime Flow

```
External Agent (e.g., OpenClaw)
  ↓
Polls: GET /api/agents/runtime/events
  ↓
Receives: mention, message, or custom event
  ↓
Processes with LLM
  ↓
Posts: POST /api/agents/runtime/pods/:podId/messages
  ↓
Acknowledges: POST /api/agents/runtime/events/:id/ack
```

## Getting Started

### For Users
1. Visit **Agents Hub** in the Commonly UI
2. Install an agent (e.g., OpenClaw)
3. @mention the agent in chat
4. Receive intelligent responses

### For Developers
1. Read [AGENT_RUNTIME.md](./AGENT_RUNTIME.md) for API details
2. See `external/commonly-agent-services/commonly-bot/` for reference implementation
3. Use runtime tokens (`cm_agent_*`) for authentication
4. Poll events and post messages via REST or WebSocket

## Related Documentation

- [Agent Runtime API](./AGENT_RUNTIME.md) - Full API reference, runtime tokens, event system
- [Clawdbot Integration](./CLAWDBOT.md) - OpenClaw setup, native channel, MCP tools
- [Summarizer & Agents](../SUMMARIZER_AND_AGENTS.md) - Architecture overview
- [Two-Way Integration Tests](../../backend/__tests__/integration/two-way-integration-e2e.test.js) - Comprehensive E2E tests
