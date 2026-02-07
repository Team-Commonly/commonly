---

name: backend-dev
description: Backend development context for Node.js/Express APIs, services, controllers, middleware, and testing patterns. Use when working on backend code.
last_updated: 2026-02-07
---

# Backend Development

**Technologies**: Node.js, Express.js, JWT, Middleware, REST APIs

## Required Knowledge
- Express.js routing and middleware
- JWT authentication/authorization
- Controller-service pattern
- Async/await and error handling
- RESTful API design

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [BACKEND.md](../../../docs/development/BACKEND.md) | API structure, endpoints, middleware, testing |
| [ARCHITECTURE.md](../../../docs/architecture/ARCHITECTURE.md) | System components, service structure |
| [DATABASE.md](../../../docs/database/DATABASE.md) | Database interactions, Mongoose/pg |

## Key Services

```
backend/services/
├── discordService.js          # Discord API integration
├── discordCommandService.js   # Slash command handlers
├── discordMultiCommandService.js # Multi-pod command fan-out
├── llmService.js              # LLM routing (LiteLLM + Gemini fallback / disable)
├── summarizerService.js       # AI summarization
├── chatSummarizerService.js   # Chat analysis
├── integrationSummaryService.js # Integration buffer summarization
├── podAssetService.js         # Indexed pod memory (PodAsset)
├── podContextService.js       # Agent-friendly pod context assembly
├── podSkillService.js         # LLM markdown skill synthesis
├── dailyDigestService.js      # Newsletter generation
├── schedulerService.js        # Cron jobs, periodic tasks
├── externalFeedService.js     # X/Instagram polling into posts + buffers
├── agentEventService.js       # Agent event queue for external runtimes
├── agentIdentityService.js    # Agent user provisioning + PG sync
├── agentMessageService.js     # Agent message posting into pods
├── telegramService.js         # Telegram helpers
└── integrationService.js      # Third-party integrations
```

## Pod Context and Integration Catalog

- `GET /api/pods/:id/context` returns structured pod context with tags, summaries, assets, and skills.
- Pod context supports `skillMode=llm|heuristic|none` plus `skillLimit` and `skillRefreshHours`.
- LLM mode can upsert markdown skills as `PodAsset(type='skill')`.
- Pod memory search endpoints: `GET /api/pods/:id/context/search` (keyword search) and `GET /api/pods/:id/context/assets/:assetId` (excerpt read).
- Integration metadata is manifest-driven and exposed via `GET /api/integrations/catalog`.
- Integration create/update routes enforce manifest-required fields before an integration can be marked `connected`.
- MVP pod roles are derived, not stored: **Admin** is the pod creator, **Member** is any listed member, **Viewer** is read-only at the access layer.
- Pod deletion authorization: pod creator or global admin (`role=admin`).
- External agent runtimes use token-auth endpoints under `/api/agents/runtime` to fetch context and post messages.
- Socket.io emits `podPresence` events to report online userIds per pod room.
- Posts can be global or pod-scoped (`post.podId`), include forum-style `category`, and carry `source` metadata for external feeds; `GET /api/posts` and `/api/posts/search` accept `podId` + `category` filters.
- X/Instagram integrations are poll-based; scheduler syncs external posts every 10 minutes and writes them as `Post` records plus integration buffers for summaries.
- `PATCH /api/skills/gateway-credentials` now applies to both local and k8s gateways; for k8s it updates the selected gateway ConfigMap skill entries.
- After gateway skill credential changes (for example Tavily API key), reprovision the relevant OpenClaw runtime or restart the selected gateway deployment.

## Key Patterns

### Controller-Service Pattern
```javascript
// Controller handles HTTP
router.post('/messages', authenticate, messageController.create);

// Service handles business logic
class MessageService {
  static async create(podId, userId, content) {
    // Validation, DB operations, etc.
  }
}
```

### Middleware Chain
```javascript
app.use(cors());
app.use(express.json());
app.use('/api', authenticate, routes);
```

## E2E Integration Testing

### Test Files
| Test File | Coverage |
|-----------|----------|
| `backend/__tests__/integration/two-way-integration-e2e.test.js` | Two-way platform integration (23 tests) |
| `backend/__tests__/integration/integrations-e2e.test.js` | Integration lifecycle, commonly-bot, Discord |
| `backend/__tests__/integration/clawdbot-e2e.test.js` | Clawdbot agent scenarios |

### Key Test Utilities
```javascript
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

// Mock summarizer to avoid Gemini API calls
jest.mock('../../services/summarizerService', () => ({
  generateSummary: jest.fn().mockResolvedValue('AI summary'),
  summarizePosts: jest.fn().mockResolvedValue({ title: 'Posts', content: '...' }),
  summarizeChats: jest.fn().mockResolvedValue({ title: 'Chats', content: '...' }),
}));

// Mock external APIs
jest.mock('axios');
global.fetch = jest.fn();
```

### Two-Way Integration Flow
```
INBOUND: External → Commonly
1. POST /api/integrations/ingest (cm_int_* token)
2. Buffer message in integration.config.messageBuffer
3. SchedulerService.summarizeIntegrationBuffers()
4. AgentEventService.enqueue() for commonly-bot
5. Agent polls /api/agents/runtime/events
6. Agent posts to /api/agents/runtime/pods/:podId/messages

OUTBOUND: Commonly → External
1. !summary command in external platform
2. Fetch Summary from pod
3. Send via Discord webhook or GroupMe bot API
```

### Multi-Agent Patterns
- Multiple agents can be installed on same pod
- Each agent receives events scoped to their agentName
- Agent chaining: commonly-bot can enqueue events for clawdbot
- Custom agents use `registry: 'commonly-community'`

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
Global admins can remove any pod agent installation via `DELETE /api/registry/agents/:name/pods/:podId` even when not pod member/installer.
