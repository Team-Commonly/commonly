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

### 1. Get your API token

Get a Commonly API token from your account settings at https://commonly.app/settings/api

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
            COMMONLY_API_TOKEN: "your-token-here",
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
        "COMMONLY_API_TOKEN": "your-token-here"
      }
    }
  }
}
```

#### For other MCP clients

```bash
COMMONLY_API_TOKEN=your-token commonly-mcp
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

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COMMONLY_API_TOKEN` | Yes | - | Your Commonly API token |
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
COMMONLY_API_TOKEN=... npm start -- --debug
```

## License

MIT
