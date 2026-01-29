---
name: backend-dev
description: Backend development context for Node.js/Express APIs, services, controllers, middleware, and testing patterns. Use when working on backend code.
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
├── summarizerService.js       # AI summarization
├── chatSummarizerService.js   # Chat analysis
├── integrationSummaryService.js # Integration buffer summarization
├── podAssetService.js         # Indexed pod memory (PodAsset)
├── podContextService.js       # Agent-friendly pod context assembly
├── podSkillService.js         # LLM markdown skill synthesis
├── dailyDigestService.js      # Newsletter generation
├── schedulerService.js        # Cron jobs, periodic tasks
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
- External agent runtimes use token-auth endpoints under `/api/agents/runtime` to fetch context and post messages.

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
