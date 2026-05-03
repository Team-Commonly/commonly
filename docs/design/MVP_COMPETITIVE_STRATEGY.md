# Commonly MVP Competitive Strategy

**Version**: 1.0
**Date**: January 28, 2026
**Status**: Strategic Planning Document — superseded for active GTM by
[ADR-011 — Shell-first pre-GTM](../adr/ADR-011-shell-first-pre-gtm.md)
(2026-04-27). Use this doc for the original Jan-2026 competitive
positioning; use ADR-011 for what's actively being built and the cut
list (Feed/Digest/Analytics hidden, Skills folded, Apps→Hire merge).

---

## Executive Summary

This document outlines the strategic improvements needed for Commonly to become a competitive MVP against moltbot/clawdbot. After comprehensive analysis of both codebases, we've identified key architectural patterns and features that will differentiate Commonly in the multi-agent context hub space.

### Strategic Positioning

| Aspect | Moltbot (Competitor) | Commonly (Our Approach) |
|--------|---------------------|-------------------------|
| **Core Model** | One powerful agent, many channels | Many scoped agents, shared structured memory |
| **Memory** | Per-session, file-based (JSONL) | Per-pod, indexed assets + derived skills |
| **Routing** | Agent bindings (channel → agent) | Pod-native agents (pod = context boundary) |
| **Context** | Direct message collapse, group isolation | Pod isolation + explicit cross-pod federation |
| **Value Prop** | "Your AI everywhere" | "Team memory that powers your agents" |

---

## Part 1: Architecture Improvements

### 1.1 Gateway Control Plane (Priority: HIGH)

**Current State**: REST API + Socket.io for real-time chat
**Target State**: Unified WebSocket Gateway as control plane

**Why This Matters**: Moltbot's Gateway is the single source of truth for all messaging, agent routing, and session state. This pattern enables:
- Consistent message delivery across channels
- Centralized session management
- Real-time event broadcasting
- Client type differentiation (operators vs nodes)

**Implementation Plan**:

```
┌─────────────────────────────────────────────────────────┐
│                   Commonly Gateway                       │
│            WebSocket Control Plane (ws://:5001)         │
├─────────────────────────────────────────────────────────┤
│  • Session Management (per-pod context)                 │
│  • Event Broadcasting (messages, summaries, skills)     │
│  • Agent Routing (pod → agent mapping)                  │
│  • Integration Event Ingestion                          │
│  • Client Authentication (operators, apps, webhooks)    │
└────────────────────────┬────────────────────────────────┘
                         │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
┌───▼────────┐    ┌─────▼──────┐    ┌───────▼────────┐
│  REST API  │    │  Socket.io │    │  Integration   │
│  (existing)│    │  (existing)│    │  Webhooks      │
└────────────┘    └────────────┘    └────────────────┘
```

**New Files**:
- `backend/gateway/index.js` - Gateway server entry
- `backend/gateway/protocol/` - Protocol definitions
- `backend/gateway/handlers/` - Message handlers
- `backend/gateway/sessions/` - Session management

### 1.2 Session-Based Context Management (Priority: HIGH)

**Current State**: Messages in PostgreSQL, summaries in MongoDB, no formal session concept
**Target State**: Pod-scoped sessions with context windowing

**Key Concepts from Moltbot**:
```javascript
// Session key format (adapted for Commonly)
sessionKey: "pod:<podId>:user:<userId>"        // User's context in a pod
sessionKey: "pod:<podId>:integration:<type>"  // Integration context
sessionKey: "pod:<podId>:agent:<agentId>"     // Agent's working context
```

**Session Schema** (new `backend/models/Session.js`):
```javascript
{
  sessionKey: String,           // Composite key
  podId: ObjectId,             // Pod boundary
  userId: ObjectId,            // User if applicable
  agentId: String,             // Agent if applicable
  transcript: [{               // JSONL-style transcript
    role: 'user' | 'assistant' | 'system' | 'tool',
    content: String | Object,
    timestamp: Date,
    metadata: Object
  }],
  tokenUsage: {
    input: Number,
    output: Number,
    context: Number
  },
  lastCompaction: Date,
  resetPolicy: {
    mode: 'daily' | 'idle' | 'never',
    atHour: Number,            // For daily mode
    idleMinutes: Number        // For idle mode
  },
  createdAt: Date,
  updatedAt: Date
}
```

### 1.3 Memory Architecture (Priority: HIGH)

**Current State**: PodAssets exist but underutilized
**Target State**: Structured memory with vector search + file-based memory files

**Layered Memory Model**:

```
┌─────────────────────────────────────────────────────────┐
│                    Layer 3: Skills                       │
│  Derived knowledge, reusable procedures, team memory    │
│  (PodSkill model - synthesized from summaries)          │
├─────────────────────────────────────────────────────────┤
│                    Layer 2: Index                        │
│  Tags, keywords, semantic embeddings, fast retrieval    │
│  (PodIndex with vector search via sqlite-vec)           │
├─────────────────────────────────────────────────────────┤
│                    Layer 1: Assets                       │
│  Raw sources: messages, files, docs, summaries          │
│  (PodAsset model - existing, enhanced)                  │
└─────────────────────────────────────────────────────────┘
```

**Pod Memory Files** (inspired by moltbot's workspace):
```
pod-<id>/
├── CONTEXT.md        # Pod purpose, instructions, agent policy
├── MEMORY.md         # Curated long-term memory (pinned facts)
├── SKILLS.md         # Active skill index (auto-generated)
├── memory/
│   ├── 2026-01-28.md # Daily activity log
│   └── 2026-01-27.md
└── assets/
    └── ...           # Uploaded files, docs
```

### 1.4 Vector Search Implementation (Priority: MEDIUM)

**Current State**: Keyword search only
**Target State**: Hybrid search (semantic + keyword)

**Implementation**:
```javascript
// backend/services/vectorSearchService.js
const { Database } = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

class VectorSearchService {
  constructor(podId) {
    this.db = new Database(`data/memory/${podId}.sqlite`);
    sqliteVec.load(this.db);
    this.initSchema();
  }

  async indexAsset(asset) {
    const embedding = await this.embed(asset.content);
    const chunks = this.chunk(asset.content, 400, 80); // 400 tokens, 80 overlap
    for (const chunk of chunks) {
      const vec = await this.embed(chunk.text);
      this.db.prepare(`
        INSERT INTO pod_chunks (asset_id, chunk_text, embedding)
        VALUES (?, ?, ?)
      `).run(asset._id, chunk.text, vec);
    }
  }

  async search(query, { limit = 10, hybrid = true } = {}) {
    const queryVec = await this.embed(query);
    // Combine vector similarity + BM25 keyword scoring
    return hybrid
      ? this.hybridSearch(queryVec, query, limit)
      : this.vectorSearch(queryVec, limit);
  }
}
```

---

## Part 2: Feature Improvements

### 2.1 Multi-Agent Architecture (Priority: HIGH)

**Current State**: Single Commonly Bot agent (external runtime)
**Target State**: Pod-native agents with routing

**Agent Profile Schema** (new `backend/models/AgentProfile.js`):
```javascript
{
  agentId: String,              // e.g., "pod-assistant", "discord-bridge"
  podId: ObjectId,              // Scoped to pod
  name: String,
  purpose: String,              // Agent's role description
  instructions: String,         // System prompt additions
  persona: {
    tone: String,               // friendly, professional, etc.
    boundaries: [String],       // Things it won't do
    specialties: [String]       // What it's good at
  },
  toolPolicy: {
    allowed: [String],          // Allowed tool categories
    blocked: [String],          // Explicitly blocked
    requireApproval: [String]   // Needs human approval
  },
  contextPolicy: {
    maxTokens: Number,          // Context window limit
    compactionThreshold: Number,
    includeMemory: Boolean,     // Load MEMORY.md
    includeSkills: Boolean      // Load pod skills
  },
  integrations: [ObjectId],     // Allowed integration sources
  status: 'active' | 'paused' | 'archived',
  createdBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

**Agent Routing**:
```javascript
// backend/services/agentRoutingService.js
class AgentRoutingService {
  async resolveAgent(message) {
    const { podId, source, userId } = message;

    // 1. Check explicit bindings
    const binding = await AgentBinding.findOne({
      podId,
      $or: [
        { source, userId },      // User-specific binding
        { source },              // Source-specific (e.g., Discord)
        {}                       // Default pod agent
      ]
    }).sort({ specificity: -1 });

    // 2. Fall back to pod's default agent
    return binding?.agentId || await this.getDefaultAgent(podId);
  }
}
```

### 2.2 Context Assembly (Priority: HIGH)

**Current State**: Raw message retrieval
**Target State**: Structured context composition

**Context Assembler** (new `backend/services/contextAssemblerService.js`):
```javascript
class ContextAssemblerService {
  async assembleContext(podId, task, options = {}) {
    const {
      includeMemory = true,
      includeSkills = true,
      includeSummaries = true,
      maxTokens = 8000
    } = options;

    const context = {
      pod: await this.getPodMetadata(podId),
      skills: [],
      assets: [],
      summaries: [],
      policies: {},
      tokenEstimate: 0
    };

    // 1. Load pod memory file (MEMORY.md equivalent)
    if (includeMemory) {
      const memory = await this.loadPodMemory(podId);
      context.memory = memory;
      context.tokenEstimate += this.estimateTokens(memory);
    }

    // 2. Search relevant skills
    if (includeSkills) {
      const skills = await this.searchSkills(podId, task, { limit: 5 });
      context.skills = skills;
      context.tokenEstimate += this.estimateTokens(skills);
    }

    // 3. Search relevant assets
    const assets = await this.searchAssets(podId, task, {
      limit: 10,
      hybrid: true
    });
    context.assets = assets.map(a => ({
      id: a._id,
      title: a.title,
      snippet: a.snippet,
      source: a.sourceRef,
      relevance: a.score
    }));

    // 4. Get recent summaries
    if (includeSummaries) {
      const summaries = await this.getRecentSummaries(podId, { hours: 24 });
      context.summaries = summaries;
    }

    // 5. Get agent policies
    const agent = await AgentProfile.findOne({ podId, status: 'active' });
    context.policies = agent?.toolPolicy || {};

    return context;
  }
}
```

**API Endpoint Enhancement**:
```javascript
// GET /api/pods/:id/context
router.get('/:id/context', auth, async (req, res) => {
  const { task, skillMode, includeMemory, maxTokens } = req.query;

  const context = await contextAssemblerService.assembleContext(
    req.params.id,
    task,
    { skillMode, includeMemory, maxTokens }
  );

  res.json({
    pod: context.pod,
    skills: context.skills,
    assets: context.assets,
    summaries: context.summaries,
    policies: context.policies,
    meta: {
      tokenEstimate: context.tokenEstimate,
      assembledAt: new Date()
    }
  });
});
```

### 2.3 Cross-Pod Federation (Priority: MEDIUM)

**Current State**: Pods are isolated
**Target State**: Explicit, auditable cross-pod collaboration

**PodLink Schema** (new `backend/models/PodLink.js`):
```javascript
{
  sourcePodId: ObjectId,        // Pod granting access
  targetPodId: ObjectId,        // Pod receiving access
  scopes: [{
    type: 'summaries:read' | 'skills:read' | 'assets:read',
    filters: {                  // Optional filters
      tags: [String],
      types: [String],
      since: Date
    }
  }],
  status: 'active' | 'pending' | 'revoked',
  approvedBy: ObjectId,         // User who approved
  expiresAt: Date,              // Optional expiration
  auditLog: [{
    action: String,
    actorId: ObjectId,
    timestamp: Date,
    details: Object
  }],
  createdAt: Date,
  updatedAt: Date
}
```

**Cross-Pod Query** (audited):
```javascript
// backend/services/federationService.js
class FederationService {
  async queryLinkedPod(sourcePodId, targetPodId, query, options = {}) {
    // 1. Verify link exists and is active
    const link = await PodLink.findOne({
      sourcePodId: targetPodId,  // Target grants access to source
      targetPodId: sourcePodId,
      status: 'active'
    });

    if (!link) throw new Error('No active link to target pod');

    // 2. Verify scope
    const hasScope = link.scopes.some(s =>
      this.matchesScope(s, query.type, query.filters)
    );
    if (!hasScope) throw new Error('Query exceeds granted scopes');

    // 3. Execute query
    const result = await this.executeQuery(targetPodId, query);

    // 4. Audit log
    await PodLink.updateOne(
      { _id: link._id },
      { $push: { auditLog: {
        action: 'cross-pod-query',
        actorId: options.userId,
        timestamp: new Date(),
        details: { queryType: query.type, resultCount: result.length }
      }}}
    );

    return result;
  }
}
```

### 2.4 Real-Time Event System (Priority: MEDIUM)

**Current State**: Socket.io for chat only
**Target State**: Full event broadcasting

**Event Types**:
```javascript
const EventTypes = {
  // Chat events
  'message.created': { podId, messageId, content, userId, timestamp },
  'message.deleted': { podId, messageId, userId },

  // Summary events
  'summary.created': { podId, summaryId, type, preview },
  'summary.updated': { podId, summaryId, changes },

  // Skill events
  'skill.created': { podId, skillId, name, sourceAssetIds },
  'skill.updated': { podId, skillId, changes },

  // Integration events
  'integration.connected': { podId, integrationId, type },
  'integration.synced': { podId, integrationId, messageCount },
  'integration.error': { podId, integrationId, error },

  // Agent events
  'agent.run.started': { podId, agentId, sessionKey },
  'agent.run.streaming': { podId, agentId, chunk },
  'agent.run.completed': { podId, agentId, tokenUsage },

  // Federation events
  'link.created': { sourcePodId, targetPodId, scopes },
  'link.queried': { sourcePodId, targetPodId, queryType }
};
```

### 2.5 App Platform Implementation (Priority: MEDIUM)

**Current State**: Design draft exists
**Target State**: Working OAuth + webhook delivery

**Implementation Phases**:

**Phase 1: Core Models**
- `App` model (Mongo)
- `AppInstallation` model (Mongo)
- App registration API (`POST /api/apps`)
- Installation flow (`GET /apps/install`)

**Phase 2: Event Delivery**
- Event queue (Redis or MongoDB change streams)
- Webhook delivery worker
- HMAC signature generation
- Retry with exponential backoff

**Phase 3: Developer Experience**
- Developer settings UI
- Consent screen
- Webhook testing tool
- Event payload documentation

---

## Part 3: Integration Improvements

### 3.1 Enhanced Discord Integration

**Current State**: Basic message sync + slash commands
**Target State**: Full bidirectional sync with thread support

**Improvements**:
1. Thread message handling (forum channels)
2. Reaction sync (emoji → pod reactions)
3. Attachment handling (images, files)
4. Server role awareness (permission-based access)

### 3.2 WhatsApp Integration (Priority: HIGH)

**Why**: WhatsApp is massive in non-US markets; moltbot has it via Baileys

**Options**:
1. **WhatsApp Cloud API** (official) - Requires business verification
2. **Baileys** (unofficial) - Same as moltbot, risky for SaaS
3. **Read-only via export** - User exports, Commonly imports

**Recommended**: WhatsApp Cloud API for SaaS compliance

### 3.3 Slack Full Implementation

**Current State**: Provider exists, partial
**Target State**: Full OAuth + Event API + slash commands

**Implementation**:
1. OAuth 2.0 flow for workspace installation
2. Event API subscription (messages, reactions, files)
3. Slash command registration
4. Interactive message components

### 3.4 iMessage/SMS (Stretch Goal)

**Approach**: Personal bridge node (like moltbot's imsg)
- macOS-only (Messages.app integration)
- Self-hosted node connects to Commonly Gateway
- Read-only initially, then bidirectional

---

## Part 4: Implementation Roadmap

### Phase 1: Foundation (Weeks 1-4)

**Week 1-2: Gateway + Sessions**
- [ ] Create Gateway server (`backend/gateway/`)
- [ ] Implement WebSocket protocol
- [ ] Add Session model and management
- [ ] Migrate Socket.io events to Gateway

**Week 3-4: Memory Architecture**
- [ ] Enhance PodAsset with memory file support
- [ ] Add PodMemory service for MEMORY.md pattern
- [ ] Implement vector search (sqlite-vec)
- [ ] Add daily activity logging

### Phase 2: Agent Layer (Weeks 5-8)

**Week 5-6: Agent Profiles**
- [ ] Create AgentProfile model
- [ ] Implement agent routing service
- [ ] Add per-pod agent configuration UI

**Week 7-8: Context Assembly**
- [ ] Build context assembler service
- [ ] Integrate vector search
- [ ] Add skill extraction pipeline
- [ ] Update `/api/pods/:id/context` endpoint

### Phase 3: Federation + Apps (Weeks 9-12)

**Week 9-10: Cross-Pod Federation**
- [ ] Create PodLink model
- [ ] Implement federation service
- [ ] Add audit logging
- [ ] Build link management UI

**Week 11-12: App Platform**
- [ ] Create App and AppInstallation models
- [ ] Implement OAuth-style flow
- [ ] Build webhook delivery system
- [ ] Create developer settings UI

### Phase 4: Polish + Launch (Weeks 13-16)

**Week 13-14: Integration Completion**
- [ ] WhatsApp Cloud API integration
- [ ] Slack full implementation
- [ ] Enhanced Discord (threads, attachments)

**Week 15-16: MVP Polish**
- [ ] Performance optimization
- [ ] Error handling improvements
- [ ] Documentation
- [ ] Beta testing

---

## Part 5: Technical Decisions

### 5.1 Database Strategy

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| Users, Pods, Memberships | MongoDB | Existing, works well |
| Messages | PostgreSQL | Relational joins, ordering |
| Sessions | MongoDB | Flexible schema, TTL |
| Vector Index | SQLite + sqlite-vec | Fast, per-pod isolation |
| App Installations | MongoDB | Flexible, OAuth patterns |

### 5.2 Caching Strategy

```javascript
// Redis (or in-memory) caching layers
{
  sessions: {
    ttl: '1h',
    key: 'session:{sessionKey}',
    invalidate: ['compaction', 'reset']
  },
  podContext: {
    ttl: '5m',
    key: 'context:{podId}:{hash}',
    invalidate: ['message', 'summary', 'skill']
  },
  vectorIndex: {
    ttl: '30m',
    key: 'vec:{podId}:query:{hash}',
    invalidate: ['asset.create', 'asset.update']
  }
}
```

### 5.3 Scale Considerations

**Per-Pod Isolation** (key advantage over moltbot):
- Each pod has its own SQLite vector index
- Context assembly is pod-scoped
- Memory is pod-local
- No cross-pod leakage by default

**Horizontal Scaling**:
- Gateway can be load-balanced (sticky sessions)
- Vector search is per-pod (no central bottleneck)
- Event delivery can use Redis pub/sub

---

## Part 6: Competitive Differentiation

### 6.1 Why Commonly Wins

| Feature | Moltbot | Commonly |
|---------|---------|----------|
| **Pod-native context** | Sessions (per-sender) | Pods (per-team/topic) |
| **Skill extraction** | Manual MEMORY.md | Auto-extracted from activity |
| **Cross-pod collab** | Not built-in | First-class with audit |
| **Self-hosted option** | Yes (complex) | Yes (Docker Compose) |
| **SaaS multi-tenant** | Limited | Designed for it |
| **Integration breadth** | 8 channels | Focus on quality over quantity |

### 6.2 Positioning Statement

> **Commonly** is the team memory platform that turns your conversations into structured knowledge. Unlike chat tools that forget everything, Commonly extracts skills, indexes context, and powers your AI agents with the right information at the right time.

### 6.3 Target Users

1. **Small Teams (5-20)**: Shared context across Discord/Slack
2. **Community Managers**: Daily digests, activity insights
3. **Developer Teams**: Pod-per-project, skill documentation
4. **AI Builders**: Structured context for their agents

---

## Appendix A: File Structure Changes

```
backend/
├── gateway/
│   ├── index.js
│   ├── protocol/
│   │   ├── schema.js
│   │   ├── handlers.js
│   │   └── events.js
│   ├── sessions/
│   │   ├── sessionStore.js
│   │   └── sessionManager.js
│   └── routing/
│       └── agentRouter.js
├── models/
│   ├── Session.js (new)
│   ├── AgentProfile.js (new)
│   ├── PodLink.js (new)
│   ├── App.js (new)
│   └── AppInstallation.js (new)
├── services/
│   ├── vectorSearchService.js (new)
│   ├── contextAssemblerService.js (new)
│   ├── federationService.js (new)
│   ├── agentRoutingService.js (new)
│   └── appWebhookService.js (new)
└── routes/
    ├── gateway.js (new)
    ├── apps.js (new)
    └── federation.js (new)
```

---

## Appendix B: Environment Variables

```bash
# Gateway
GATEWAY_PORT=5001
GATEWAY_BIND=127.0.0.1
GATEWAY_TOKEN=optional-auth-token

# Vector Search
EMBEDDING_PROVIDER=openai|gemini|local
EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=...

# App Platform
APP_WEBHOOK_TIMEOUT=10000
APP_WEBHOOK_RETRIES=3
APP_WEBHOOK_SECRET_LENGTH=32

# Federation
FEDERATION_MAX_QUERY_DEPTH=2
FEDERATION_AUDIT_RETENTION_DAYS=90
```

---

## Appendix C: Migration Path

### From Current State

1. **Sessions**: Create Session records from existing message history
2. **Memory Files**: Generate MEMORY.md from existing summaries
3. **Vector Index**: Rebuild indices from PodAssets
4. **Agent Profiles**: Create default agent per existing pod

### Data Migration Script

```javascript
// scripts/migrate-to-mvp.js
async function migrate() {
  // 1. Create sessions from message history
  const pods = await Pod.find({});
  for (const pod of pods) {
    await createSessionFromHistory(pod._id);
  }

  // 2. Generate memory files
  for (const pod of pods) {
    await generateMemoryFile(pod._id);
  }

  // 3. Build vector indices
  for (const pod of pods) {
    await rebuildVectorIndex(pod._id);
  }

  // 4. Create default agent profiles
  for (const pod of pods) {
    await createDefaultAgent(pod._id);
  }
}
```

---

*This document should be reviewed and updated as implementation progresses.*
