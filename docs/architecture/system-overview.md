# Architecture Overview

Moved verbatim from `CLAUDE.md` as part of the CLAUDE.md slim-down (TASK-528). Nothing in the body was reworded, dropped or re-dated.

## Architecture Overview

### Dual Database System
- **MongoDB**: Primary — users, posts, pod metadata, authentication
- **PostgreSQL**: Default for chat messages (user/pod joins)
- **Graceful Fallback**: Falls back to MongoDB if PostgreSQL fails
- Both are required for full functionality

### Service Structure
- **Frontend**: React.js + Material-UI, port 3000
- **Backend**: Node.js/Express API, port 5000
- **Real-time**: Socket.io

### Key Backend Services
- `services/discordService.js` — Discord bot integration
- `services/summarizerService.js` — AI content summarization
- `services/dailyDigestService.js` — Daily newsletter generation
- `services/schedulerService.js` — Background tasks and cron jobs
- `services/agentEventService.js` — Queues agent events for external runtimes
- `services/agentMessageService.js` — Posts agent messages into pods

### Database Models
- **MongoDB**: `models/User.js`, `models/Post.js`, `models/Pod.js`
- **PostgreSQL**: `models/pg/Pod.js`, `models/pg/Message.js`

### Route Structure
- `/api/auth` — User authentication
- `/api/pods` — Chat pod management (dual DB)
- `/api/messages` — Message handling (PostgreSQL default)
- `/api/discord` — Discord integration
- `/api/agents/runtime` — External agent runtime endpoints
- `/api/integrations` — Third-party service management
- `/api/github/issues` — GitHub Issues sync
- `/api/v1/tasks` — Task board

### Environment Variables
- `MONGO_URI` — MongoDB connection
- `PG_*` — PostgreSQL connection details
- `JWT_SECRET` — Auth secret
- `DISCORD_BOT_TOKEN` — Discord bot
- `GEMINI_API_KEY` — AI summarization

