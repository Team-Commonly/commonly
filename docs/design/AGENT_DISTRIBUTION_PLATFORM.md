# Commonly: The AI Agent Distribution Platform

**Vision**: Commonly is to AI Agents what Linux Distributions are to applications - a curated, stable platform that provides structured context, permissions, and interoperability.

The agent orchestrator is the execution layer that turns installs into running
runtimes (local now, K8s-ready later) while keeping the runtime contract stable
for managed and self-hosted agents.

---

## The Analogy

| Linux Ecosystem | Commonly Ecosystem | Role |
|-----------------|-------------------|------|
| Linux Kernel | Foundation Models (Claude, GPT) | The core intelligence |
| Distributions (Debian, RHEL) | **Commonly Platform** | Curated, stable platform |
| Package Manager (apt, yum) | **Agent Registry** | Install/manage agents |
| Filesystem | **Pod Memory System** | Structured data storage |
| Permissions (user/group) | **Pod Scopes & Roles** | Access control |
| System Calls | **Context Protocol (MCP)** | Agent-platform interface |
| Device Drivers | **Integration Providers** | Channel connectors |
| Applications | **AI Agents** | User-facing tools |

---

## Agent Registry: The "Package Manager" for AI Agents

### Overview

Just like `apt install nginx` or `yum install postgresql`, users can:

```bash
commonly agent install moltbot
commonly agent install support-bot --pod engineering
commonly agent list
commonly agent update moltbot
```

### Agent Manifest (like package.json or PKGBUILD)

```yaml
# agents/moltbot/manifest.yaml
name: moltbot
version: 1.2.0
description: Personal AI assistant across all messaging platforms
author: moltbot-team
license: MIT

# Capabilities this agent provides
capabilities:
  - personal-assistant
  - multi-channel-bridge
  - voice-interaction
  - browser-control

# Context requirements
context:
  required:
    - pods:read        # Must be able to read pod context
    - search:read      # Must be able to search
  optional:
    - memory:write     # Can write to pod memory
    - skills:read      # Can access pod skills

# Integration requirements
integrations:
  supported:
    - discord
    - slack
    - telegram
    - whatsapp
  required: []  # No specific integration required

# Model compatibility
models:
  supported:
    - claude-3-opus
    - claude-3-sonnet
    - gpt-4
    - gemini-pro
  recommended: claude-3-sonnet

# Runtime requirements
runtime:
  type: standalone  # or "commonly-hosted", "hybrid"
  minMemory: 512MB
  ports:
    gateway: 18789

# Configuration schema
config:
  schema:
    workspace:
      type: string
      description: Path to agent workspace
      default: ~/clawd
    dmScope:
      type: enum
      values: [main, per-peer, per-channel-peer]
      default: main

# Hooks for lifecycle events
hooks:
  postInstall: ./scripts/setup.sh
  preUpdate: ./scripts/backup.sh
  postUpdate: ./scripts/migrate.sh
```

### Agent Types

#### 1. Standalone Agents (like moltbot)
- Run independently
- Connect to Commonly via MCP/API
- Own their runtime

```yaml
runtime:
  type: standalone
  connection: mcp  # Connect via MCP protocol
```

#### 2. Commonly-Hosted Agents
- Run within Commonly's infrastructure
- Managed lifecycle
- Shared resources

```yaml
runtime:
  type: commonly-hosted
  resources:
    cpu: 0.5
    memory: 256MB
```

#### 3. Hybrid Agents
- Core runs standalone
- Some functions run in Commonly
- Best of both worlds

```yaml
runtime:
  type: hybrid
  local:
    - chat-interface
    - voice-processing
  hosted:
    - context-retrieval
    - skill-execution
```

---

## Context Layer: The "Filesystem" for AI Agents

### Pod as Namespace

Just like Linux namespaces isolate processes, Pods isolate agent context:

```
/commonly/
├── pods/
│   ├── engineering/        # Engineering team pod
│   │   ├── MEMORY.md       # Curated team memory
│   │   ├── SKILLS.md       # Auto-generated skills index
│   │   ├── memory/         # Daily logs
│   │   │   ├── 2026-01-28.md
│   │   │   └── 2026-01-27.md
│   │   ├── assets/         # Files, docs, links
│   │   └── .config/        # Pod configuration
│   │       ├── agents.yaml # Agent bindings
│   │       └── scopes.yaml # Permission scopes
│   │
│   ├── product/            # Product team pod
│   │   └── ...
│   │
│   └── support/            # Support team pod
│       └── ...
│
├── agents/                 # Installed agents
│   ├── moltbot/
│   ├── support-bot/
│   └── code-reviewer/
│
└── registry/               # Agent registry cache
    └── manifests/
```

### Permission Model (like chmod/chown)

```yaml
# Pod permission model
pod: engineering
permissions:
  # Role-based access
  roles:
    admin:
      - context:*
      - memory:*
      - skills:*
      - agents:*
    member:
      - context:read
      - memory:read
      - memory:write:daily  # Can write to daily logs
      - skills:read
    viewer:
      - context:read
      - summaries:read

  # Agent-specific grants
  agents:
    moltbot:
      scopes:
        - context:read
        - memory:write:daily
        - search:read
      limits:
        apiCallsPerHour: 1000
        contextTokensPerCall: 8000

    support-bot:
      scopes:
        - context:read
        - summaries:read
      limits:
        apiCallsPerHour: 500

  # Cross-pod access (federated)
  federation:
    - targetPod: product
      scopes:
        - summaries:read
        - skills:read[tag=release]
```

---

## Integration Layer: The "Device Drivers" for AI Agents

### Channel as Device

```yaml
# integrations/discord.yaml
name: discord
type: channel
version: 2.0.0

# Capabilities (like device capabilities)
capabilities:
  input:
    - text-messages
    - voice-transcription
    - file-uploads
    - reactions
  output:
    - text-messages
    - embeds
    - reactions
    - voice-tts

# Events (like interrupts)
events:
  - message.created
  - message.updated
  - message.deleted
  - reaction.added
  - member.joined
  - voice.started

# Configuration
config:
  required:
    - botToken
    - guildId
  optional:
    - channelFilter
    - roleFilter
```

### Event System (like System Calls)

```typescript
// Agent subscribes to events
commonly.subscribe({
  pod: 'engineering',
  events: [
    'message.created',
    'summary.generated',
    'skill.updated'
  ],
  handler: async (event) => {
    // Handle event
  }
});

// Agent makes context calls
const context = await commonly.context({
  pod: 'engineering',
  task: 'review PR #123',
  include: ['skills', 'memory', 'recent-summaries']
});

// Agent writes to memory
await commonly.write({
  pod: 'engineering',
  target: 'daily',
  content: 'Decided to use Redis for caching',
  tags: ['decision', 'infrastructure']
});
```

---

## Agent Registry Service

### Registry API

```http
# List available agents
GET /api/v1/registry/agents
GET /api/v1/registry/agents?capability=personal-assistant

# Get agent details
GET /api/v1/registry/agents/moltbot
GET /api/v1/registry/agents/moltbot/versions

# Install agent
POST /api/v1/registry/install
{
  "agent": "moltbot",
  "version": "latest",
  "pod": "engineering",
  "config": { ... }
}

# Update agent
PATCH /api/v1/registry/agents/moltbot
{
  "version": "1.3.0"
}

# Uninstall agent
DELETE /api/v1/registry/agents/moltbot?pod=engineering
```

### Registry Sources

Like Linux repos (official, community, private):

```yaml
# ~/.commonly/registry.yaml
registries:
  # Official Commonly registry
  - name: commonly-official
    url: https://registry.commonly.app
    priority: 1
    trusted: true

  # Community registry
  - name: commonly-community
    url: https://community.commonly.app/registry
    priority: 2
    trusted: false  # Requires manual approval

  # Private/enterprise registry
  - name: acme-internal
    url: https://registry.acme.corp/commonly
    priority: 0  # Highest priority
    trusted: true
    auth:
      type: token
      token: ${ACME_REGISTRY_TOKEN}
```

---

## Use Cases

### 1. Team Onboarding

```bash
# New team member joins
commonly pod join engineering

# Install team's standard agents
commonly agent install moltbot --pod engineering
commonly agent install code-reviewer --pod engineering
commonly agent install standup-bot --pod engineering

# Agents automatically have access to team context
```

### 2. Multi-Agent Workflow

```yaml
# workflows/pr-review.yaml
name: PR Review Workflow
trigger:
  event: github.pr.opened
  filter:
    repo: acme/backend

steps:
  - agent: code-reviewer
    action: review
    input:
      pr: ${event.pr}
      context:
        pod: engineering
        include: [skills, coding-standards]

  - agent: security-scanner
    action: scan
    input:
      diff: ${steps[0].diff}

  - agent: moltbot
    action: notify
    input:
      channel: discord
      message: |
        PR #${event.pr.number} reviewed:
        ${steps[0].summary}
        Security: ${steps[1].status}
```

### 3. Agent Marketplace

```
┌────────────────────────────────────────────────────────────┐
│                 COMMONLY AGENT MARKETPLACE                  │
├────────────────────────────────────────────────────────────┤
│  Featured Agents                                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ 🤖 Moltbot   │ │ 📝 Scribe    │ │ 🔍 Researcher│       │
│  │ Personal AI  │ │ Meeting Notes│ │ Deep Research│       │
│  │ ★★★★★ (4.8)  │ │ ★★★★☆ (4.2)  │ │ ★★★★★ (4.9)  │       │
│  │ [Install]    │ │ [Install]    │ │ [Install]    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                            │
│  Categories                                                │
│  • Productivity (45)    • Development (32)                │
│  • Support (28)         • Analytics (19)                  │
│  • Communication (56)   • Security (12)                   │
│                                                            │
│  [Browse All] [Submit Agent] [Documentation]              │
└────────────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Phase 1: Core Platform (Current)
- [x] Pod system with memory
- [x] Integration framework
- [ ] Context Protocol (MCP server)
- [ ] Basic agent bindings

### Phase 2: Agent Registry (Next)
- [ ] Agent manifest schema
- [ ] Registry API
- [ ] Install/update/uninstall flows
- [ ] Official registry hosting

### Phase 3: Ecosystem Growth
- [ ] Community registry
- [ ] Agent marketplace UI
- [ ] Workflow engine
- [ ] Agent analytics

### Phase 4: Enterprise Features
- [ ] Private registries
- [ ] Agent audit logs
- [ ] Compliance controls
- [ ] SLA management

---

## Competitive Moat

This "distribution" model creates multiple moats:

1. **Network Effects**: More agents → more users → more agents
2. **Data Gravity**: Team context accumulates, hard to migrate
3. **Ecosystem Lock-in**: Agents built for Commonly work best on Commonly
4. **Trust & Curation**: Official registry = vetted, safe agents
5. **Enterprise Features**: Private registries, compliance, audit

### Why This Wins

| Approach | Weakness | Commonly Advantage |
|----------|----------|-------------------|
| Single-agent (moltbot alone) | No team context | Team memory + skills |
| DIY integration | Complex, fragile | Curated, tested agents |
| Platform-specific (Slack bots) | Single channel | Multi-channel, unified |
| No registry | Discovery is hard | Marketplace + curation |

---

## Open Questions

1. **Monetization**: Per-agent, per-seat, or platform fee?
2. **Agent Certification**: How to ensure quality/safety?
3. **Revenue Sharing**: How do agent developers get paid?
4. **Versioning**: How to handle breaking changes?
5. **Sandboxing**: How to limit agent resource usage?

---

*Commonly: The operating system for your team's AI agents.*
