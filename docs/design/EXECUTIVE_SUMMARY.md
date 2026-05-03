# Commonly: Strategic Transformation Summary

**Date**: January 28, 2026
**Status**: Implementation Phase 1 Complete — frozen Jan-2026 snapshot.
For current state read
[`docs/COMMONLY_SCOPE.md`](../COMMONLY_SCOPE.md) (live scope) and
[ADR-011 — Shell-first pre-GTM](../adr/ADR-011-shell-first-pre-gtm.md)
(active strategic frame). The "transformation" thesis here turned into
the kernel/shell/driver architecture that's now real.

---

## The Vision

Commonly is transforming from a "team chat platform" into **the context hub for AI agents** - similar to how Linux distributions (Debian, AlmaLinux) provide a curated platform for applications on top of the Linux kernel.

```
┌─────────────────────────────────────────────────────────────┐
│                    AI AGENTS                                 │
│  Moltbot │ Claude Code │ Custom Agents │ Support Bots       │
└─────────────────────────┬───────────────────────────────────┘
                          │ MCP / Context Protocol
┌─────────────────────────▼───────────────────────────────────┐
│              COMMONLY CONTEXT HUB                            │
│  "The distribution platform for AI agents"                  │
│                                                              │
│  • Structured pod memory (like filesystem)                  │
│  • Agent Registry (like apt/yum)                            │
│  • Permissions & scopes (like user/group)                   │
│  • Integration sources (like device drivers)                │
└─────────────────────────────────────────────────────────────┘
```

---

## What We Built

### 1. MCP Server (`@commonly/mcp-server`)

A complete MCP (Model Context Protocol) server that allows any compatible agent to connect to Commonly:

**Tools provided:**
- `commonly_pods` - List accessible pods
- `commonly_search` - Hybrid search over pod memory
- `commonly_context` - Get structured context for tasks
- `commonly_read` - Read assets and memory files
- `commonly_write` - Write to pod memory
- `commonly_skills` - Get derived skills

**Usage with moltbot:**
```json5
{
  tools: {
    mcp: {
      servers: {
        "commonly": {
          command: "commonly-mcp",
          env: {
            COMMONLY_USER_TOKEN: "your-token"
          }
        }
      }
    }
  }
}
```

### 2. Context API (v1)

RESTful API endpoints that power the MCP server and enable direct agent integration:

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/pods` | List user's pods |
| `GET /api/v1/context/:podId` | Assembled context |
| `GET /api/v1/search/:podId` | Hybrid search |
| `GET /api/v1/pods/:podId/skills` | Pod skills |
| `POST /api/v1/memory/:podId` | Write to memory |

### 3. Session Management

Pod-scoped sessions with:
- JSONL-style transcript storage
- Token usage tracking
- Compaction and reset policies
- Idle timeout management

### 4. Agent Profiles

Per-pod agent configuration:
- Persona (tone, boundaries, specialties)
- Tool policies (allowed, blocked, requires approval)
- Context policies (token limits, what to include)
- Model preferences

### 5. Agent Registry

"Package manager" for AI agents:
- Agent manifests (like package.json)
- Per-pod installations
- Version management
- Usage tracking

---

## Strategic Positioning

### vs. Moltbot (Complementary, Not Competitive)

| Layer | Moltbot | Commonly |
|-------|---------|----------|
| Agent Runtime | ✅ Excellent | Not competing |
| Channel Bridge | ✅ 8+ channels | Focus on key ones |
| **Context/Memory** | File-based (personal) | **Structured pods (team)** |
| **Skills** | Manual MEMORY.md | **Auto-extracted** |

**The synergy**: Moltbot handles personal agent runtime; Commonly provides team context.

### The Linux Analogy

| Linux | Commonly |
|-------|----------|
| Kernel | Foundation Models (Claude, GPT) |
| Distribution | Commonly Platform |
| Package Manager | Agent Registry |
| Filesystem | Pod Memory System |
| Permissions | Pod Scopes & Roles |
| System Calls | Context Protocol (MCP) |
| Device Drivers | Integration Providers |
| Applications | AI Agents |

---

## Files Created

### MCP Server Package
```
packages/commonly-mcp/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts         # Server entry
    ├── cli.ts           # CLI wrapper
    ├── client.ts        # Commonly API client
    ├── tools/index.ts   # MCP tools
    └── resources/index.ts # MCP resources
```

### Backend Models & Services
```
backend/
├── models/
│   ├── Session.js           # Pod-scoped sessions
│   ├── AgentProfile.js      # Pod-native agents
│   └── AgentRegistry.js     # Agent distribution
├── services/
│   └── contextAssemblerService.js  # Context assembly
└── routes/
    └── contextApi.js        # v1 API endpoints
```

### Documentation
```
docs/design/
├── MVP_COMPETITIVE_STRATEGY.md      # Full strategy doc
├── COMMONLY_AS_CONTEXT_HUB.md       # Context hub vision
├── AGENT_DISTRIBUTION_PLATFORM.md   # Distribution model
└── EXECUTIVE_SUMMARY.md             # This file
```

---

## Implementation Roadmap

### Phase 1: Foundation ✅ COMPLETE
- [x] Session model and management
- [x] AgentProfile model
- [x] Context Assembler service
- [x] Context API v1 routes
- [x] MCP server package
- [x] Agent Registry model

### Phase 2: Enhancement (Next 2-4 weeks)
- [ ] Vector search with sqlite-vec
- [ ] Gateway WebSocket control plane
- [ ] Agent Registry routes and UI
- [ ] Cross-pod federation

### Phase 3: Ecosystem (Weeks 5-8)
- [ ] App Platform implementation
- [ ] Moltbot provider integration
- [ ] Agent marketplace UI
- [ ] Workflow engine

### Phase 4: Scale (Weeks 9-12)
- [ ] Private registries
- [ ] Enterprise features
- [ ] Mobile apps
- [ ] Advanced analytics

---

## Competitive Moats

1. **Network Effects**: More teams → more context → more valuable for agents
2. **Data Gravity**: Team knowledge accumulates, hard to migrate
3. **Ecosystem Lock-in**: Agents built for Commonly work best on Commonly
4. **Trust & Curation**: Official registry = vetted, safe agents
5. **Enterprise Features**: Private registries, compliance, audit

---

## Key Use Cases

### 1. Personal Agent with Team Context
```
User (via moltbot): "What's our deployment process?"
→ Moltbot searches Commonly pod
→ Returns team's documented process with context
```

### 2. Cross-Team Knowledge
```
User: "What did engineering decide about rate limits?"
→ Agent queries engineering pod (with permission)
→ Returns decision with audit trail
```

### 3. Persistent Team Memory
```
User: "Save this decision to engineering"
→ Agent writes to pod's daily log
→ Team members see it, skills get extracted
```

### 4. Multi-Agent Workflows
```
PR opened → code-reviewer agent → security-scanner
          → results posted to engineering pod
          → team notified via moltbot
```

---

## Next Steps

1. **Test the MCP server** with a local Commonly instance
2. **Build vector search** for better context retrieval
3. **Create agent registry UI** for discovery
4. **Write integration guide** for moltbot users
5. **Set up official registry** hosting

---

## Commands Reference

```bash
# Build MCP server
cd packages/commonly-mcp && npm install && npm run build

# Start backend with new APIs
cd backend && npm run dev

# Test Context API
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:5000/api/v1/pods

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/v1/context/$POD_ID?task=review+PR"

# Use MCP server
COMMONLY_USER_TOKEN=... commonly-mcp --debug
```

---

*Commonly: The operating system for your team's AI agents.*
