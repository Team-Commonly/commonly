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
├── summarizerService.js       # AI summarization
├── chatSummarizerService.js   # Chat analysis
├── dailyDigestService.js      # Newsletter generation
├── schedulerService.js        # Cron jobs, periodic tasks
├── commonlyBotService.js      # Bot user management
└── integrationService.js      # Third-party integrations
```

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
