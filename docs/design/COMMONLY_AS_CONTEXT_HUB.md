# Commonly as Context Hub for AI Agents

**Vision**: Commonly is the structured context backend that any AI agent (moltbot, Claude Code, LangChain, custom agents) can connect to for team/group memory.

---

## Strategic Positioning

### The Insight

| Layer | Moltbot | Commonly | Together |
|-------|---------|----------|----------|
| **Agent Runtime** | ✅ Excellent | Not competing | Moltbot runs the agent |
| **Channel Bridge** | ✅ 8+ channels | Focus on key ones | Moltbot bridges more |
| **Context/Memory** | File-based (personal) | Structured pods (team) | **Commonly provides team context** |
| **Skills** | Manual MEMORY.md | Auto-extracted | **Commonly synthesizes skills** |

### The Value Proposition

> **Moltbot** = Your personal AI assistant across all your messaging apps
> **Commonly** = The team brain your agents connect to

**Together**: Your personal agent has access to your team's structured knowledge, not just your personal files.

---

## Architecture: Commonly Context Protocol

### Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        AGENT LAYER                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ Moltbot  │  │ Claude   │  │ LangChain│  │ Custom Agents    │ │
│  │ (Pi)     │  │ Code     │  │ Agents   │  │ (MCP compatible) │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
│       │             │             │                  │           │
│       └─────────────┴─────────────┴──────────────────┘           │
│                              │                                    │
│                    ┌─────────▼─────────┐                         │
│                    │  MCP / REST API   │                         │
│                    │  Context Protocol │                         │
│                    └─────────┬─────────┘                         │
└──────────────────────────────┼───────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                    COMMONLY CONTEXT HUB                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                      Context API                             │ │
│  │  • GET /context/:podId - Structured context assembly         │ │
│  │  • POST /memory/:podId - Write memories/facts                │ │
│  │  • GET /skills/:podId - Pod-derived skills                   │ │
│  │  • GET /search/:podId - Hybrid vector + keyword search       │ │
│  │  • WS /stream/:podId - Real-time context updates            │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐ │
│  │ Pod Memory  │ │ Pod Skills  │ │ Summaries   │ │ Assets     │ │
│  │ MEMORY.md   │ │ auto-synth  │ │ hourly/daily│ │ files,docs │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   Integration Sources                        │ │
│  │  Discord │ Slack │ Telegram │ GroupMe │ WhatsApp │ Web      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## MCP Server: commonly-context

Commonly exposes an MCP (Model Context Protocol) server that any compatible agent can use:

### Tools Provided

```typescript
// commonly-context MCP server tools

/**
 * Search pod memory using hybrid vector + keyword search
 */
tool commonly_search {
  podId: string,           // Pod to search
  query: string,           // Natural language query
  limit?: number,          // Max results (default 10)
  types?: string[],        // Asset types to include
  since?: string           // ISO date filter
}
// Returns: { results: [{ title, snippet, source, relevance }] }

/**
 * Get structured context for a task
 */
tool commonly_context {
  podId: string,           // Pod to get context from
  task?: string,           // Optional task description for relevance
  includeSkills?: boolean, // Include derived skills
  includeMemory?: boolean, // Include MEMORY.md content
  maxTokens?: number       // Token budget
}
// Returns: { skills: [], assets: [], summaries: [], memory: string }

/**
 * Read a specific asset or memory file
 */
tool commonly_read {
  podId: string,
  assetId?: string,        // Specific asset ID
  path?: string            // Or virtual path like "MEMORY.md", "memory/2026-01-28.md"
}
// Returns: { content: string, metadata: {} }

/**
 * Write to pod memory (append to daily log or update MEMORY.md)
 */
tool commonly_write {
  podId: string,
  target: "daily" | "memory" | "skill",
  content: string,
  tags?: string[]
}
// Returns: { success: boolean, assetId: string }

/**
 * List pods the agent has access to
 */
tool commonly_pods {
  // No params - returns pods based on auth
}
// Returns: { pods: [{ id, name, description, role }] }
```

### MCP Server Implementation

```javascript
// packages/commonly-mcp/src/server.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
  name: "commonly-context",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {},
    resources: {}
  }
});

// Tool: commonly_search
server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "commonly_search") {
    const { podId, query, limit, types, since } = request.params.arguments;
    const results = await commonlyClient.search(podId, query, { limit, types, since });
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  }
  // ... other tools
});

// Resources: Pod memory files as virtual resources
server.setRequestHandler("resources/list", async () => {
  const pods = await commonlyClient.listPods();
  return {
    resources: pods.flatMap(pod => [
      {
        uri: `commonly://${pod.id}/MEMORY.md`,
        name: `${pod.name} - Memory`,
        mimeType: "text/markdown"
      },
      {
        uri: `commonly://${pod.id}/SKILLS.md`,
        name: `${pod.name} - Skills`,
        mimeType: "text/markdown"
      }
    ])
  };
});
```

---

## Moltbot Integration

### Option 1: MCP Tool Integration

Add Commonly as an MCP server in moltbot's configuration:

```json5
// moltbot config
{
  tools: {
    mcp: {
      servers: {
        "commonly": {
          command: "npx",
          args: ["@commonly/mcp-server"],
          env: {
            COMMONLY_API_URL: "https://api.commonly.app",
            COMMONLY_API_TOKEN: "..."
          }
        }
      }
    }
  }
}
```

Now moltbot can use:
- `commonly_search` - Search team knowledge
- `commonly_context` - Get structured context for tasks
- `commonly_read` - Read specific documents
- `commonly_write` - Save memories back to team pods

### Option 2: Memory Provider Integration

Commonly can serve as moltbot's `memorySearch` provider:

```json5
// moltbot config
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "commonly",  // New provider type
        config: {
          apiUrl: "https://api.commonly.app",
          apiToken: "...",
          defaultPodId: "team-engineering",
          includePods: ["team-engineering", "team-product"]
        }
      }
    }
  }
}
```

This makes Commonly's vector search the backend for moltbot's `memory_search` tool.

### Option 3: Workspace Sync

Sync moltbot's workspace files from Commonly pods:

```json5
// moltbot config
{
  workspace: {
    sync: {
      provider: "commonly",
      podId: "team-engineering",
      files: {
        "MEMORY.md": "commonly://team-engineering/MEMORY.md",
        "SKILLS.md": "commonly://team-engineering/SKILLS.md",
        "memory/": "commonly://team-engineering/memory/"
      },
      pullInterval: "5m",  // Sync every 5 minutes
      pushOnWrite: true    // Push changes back to Commonly
    }
  }
}
```

---

## API Design: Context Protocol

### Authentication

```http
Authorization: Bearer <commonly-api-token>
X-Commonly-Pod: <pod-id>  // Optional default pod
```

Tokens are scoped:
- `pods:read` - List and read pod metadata
- `context:read` - Read pod context, skills, assets
- `context:write` - Write to pod memory
- `search:read` - Use vector search
- `realtime:subscribe` - Subscribe to context updates

### Endpoints

#### GET /api/v1/context/:podId

Get assembled context for a pod.

```http
GET /api/v1/context/pod_abc123?task=review%20PR&maxTokens=4000
Authorization: Bearer <token>
```

Response:
```json
{
  "pod": {
    "id": "pod_abc123",
    "name": "Engineering Team",
    "description": "Backend development discussions"
  },
  "context": {
    "memory": "# Team Memory\n\n- We use TypeScript for all new code...",
    "skills": [
      {
        "id": "skill_1",
        "name": "Code Review Checklist",
        "instructions": "1. Check for TypeScript errors...",
        "tags": ["review", "code-quality"]
      }
    ],
    "assets": [
      {
        "id": "asset_1",
        "title": "PR #123 Discussion",
        "snippet": "Decision: Use Redis for caching...",
        "source": { "type": "discord", "channelId": "..." },
        "relevance": 0.92
      }
    ],
    "summaries": [
      {
        "id": "sum_1",
        "period": "2026-01-28T00:00:00Z/2026-01-28T01:00:00Z",
        "content": "Team discussed caching strategies..."
      }
    ]
  },
  "meta": {
    "tokenEstimate": 3200,
    "assembledAt": "2026-01-28T10:30:00Z"
  }
}
```

#### POST /api/v1/memory/:podId

Write to pod memory.

```http
POST /api/v1/memory/pod_abc123
Authorization: Bearer <token>
Content-Type: application/json

{
  "target": "daily",  // or "memory", "skill"
  "content": "Decided to use Redis for session caching. @alice will implement.",
  "tags": ["decision", "caching", "redis"],
  "source": {
    "agent": "moltbot",
    "sessionId": "session_xyz"
  }
}
```

#### GET /api/v1/search/:podId

Hybrid search over pod knowledge.

```http
GET /api/v1/search/pod_abc123?q=caching+strategies&limit=5
Authorization: Bearer <token>
```

Response:
```json
{
  "results": [
    {
      "id": "asset_1",
      "title": "Caching Architecture Discussion",
      "snippet": "We evaluated Redis vs Memcached...",
      "source": { "type": "summary", "summaryId": "sum_1" },
      "relevance": 0.94,
      "matchType": "hybrid"  // vector + keyword match
    }
  ],
  "meta": {
    "query": "caching strategies",
    "totalResults": 12,
    "searchTime": 45
  }
}
```

#### WebSocket /api/v1/stream/:podId

Real-time context updates.

```javascript
const ws = new WebSocket('wss://api.commonly.app/api/v1/stream/pod_abc123');
ws.send(JSON.stringify({
  type: 'subscribe',
  events: ['summary.created', 'skill.updated', 'memory.written']
}));

ws.onmessage = (event) => {
  const { type, payload } = JSON.parse(event.data);
  // Handle context updates in real-time
};
```

---

## Use Cases

### 1. Personal Agent with Team Context

**Scenario**: Developer using moltbot for personal productivity, but needs team knowledge.

```
User (via WhatsApp): "What's our caching strategy?"

Moltbot:
1. Calls commonly_search(podId="engineering", query="caching strategy")
2. Gets relevant assets and summaries
3. Synthesizes answer with team context

Response: "Based on your team's discussions, you decided to use Redis
for session caching (Jan 25 decision). Alice is implementing it.
The architecture doc is in the engineering pod."
```

### 2. Cross-Team Knowledge Access

**Scenario**: Product manager needs engineering context.

```
User: "What did engineering decide about the API rate limits?"

Moltbot:
1. Calls commonly_context(podId="engineering", task="API rate limits")
2. Gets relevant skills, assets, summaries
3. Respects scope (product team has read access to engineering summaries)

Response: "Engineering decided on 100 req/min for free tier,
1000 req/min for paid (Jan 26). Implementation is in progress."
```

### 3. Meeting Follow-up with Team Memory

**Scenario**: After a meeting, agent writes key decisions to team memory.

```
User: "Save the key decisions from today's standup"

Moltbot:
1. Extracts decisions from conversation
2. Calls commonly_write(podId="engineering", target="daily", content="...")
3. Tags with relevant topics

Result: Decisions saved to commonly://engineering/memory/2026-01-28.md
```

### 4. Skill-Powered Task Execution

**Scenario**: Agent uses team-derived skills for consistent execution.

```
User: "Review this PR using our team's checklist"

Moltbot:
1. Calls commonly_context(podId="engineering", includeSkills=true)
2. Gets "Code Review Checklist" skill with instructions
3. Applies skill to PR review

Result: Review follows team's established patterns
```

---

## Implementation Roadmap

### Phase 1: Context API (Weeks 1-2)

- [ ] REST API endpoints for context, search, memory
- [ ] Token-based authentication with scopes
- [ ] Basic rate limiting

### Phase 2: MCP Server (Weeks 3-4)

- [ ] `@commonly/mcp-server` npm package
- [ ] All 5 tools implemented
- [ ] Resource exposure for memory files

### Phase 3: Moltbot Integration (Weeks 5-6)

- [ ] Memory provider integration option
- [ ] Workspace sync option
- [ ] Documentation and examples

### Phase 4: Real-time & Polish (Weeks 7-8)

- [ ] WebSocket streaming API
- [ ] Context change notifications
- [ ] Performance optimization

---

## Competitive Moat

This positioning creates a strong moat:

1. **Network Effects**: More teams on Commonly = more valuable context for agents
2. **Integration Lock-in**: Once agents depend on Commonly context, switching is hard
3. **Data Gravity**: Team knowledge accumulates in Commonly over time
4. **Agent Agnostic**: Works with any agent (moltbot, Claude, custom), not locked to one

### Why Moltbot Users Would Want This

- **Team Context**: Personal agent + team knowledge is more powerful than either alone
- **No Duplication**: Team decisions don't need to be manually copied to personal MEMORY.md
- **Real-time Sync**: When team makes decisions, agent knows immediately
- **Audit Trail**: Clear record of what context agents accessed

### Why We Win

| Feature | Personal Agent Only | Commonly + Agent |
|---------|---------------------|------------------|
| Personal context | ✅ | ✅ |
| Team context | ❌ Manual | ✅ Automatic |
| Cross-team knowledge | ❌ | ✅ Scoped access |
| Skill consistency | ❌ Per-person | ✅ Team-wide |
| Context freshness | Manual updates | Real-time sync |

---

## Open Questions

1. **Pricing Model**: Per-seat, per-pod, per-API-call, or hybrid?
2. **Free Tier**: How much context API access for free users?
3. **Self-Hosted**: Can users run Commonly as their own context hub?
4. **Privacy**: How to handle sensitive team information accessed by personal agents?
5. **Conflict Resolution**: What if agent writes conflict with team memory?

---

*This document defines Commonly's strategic pivot from "chat platform" to "context hub for AI agents".*
