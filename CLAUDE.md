# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Docker Setup

#### Development Environment (Recommended)
- `./dev.sh up` - Start development environment with live reloading
- `./dev.sh down` - Stop development environment
- `./dev.sh restart` - Restart development environment
- `./dev.sh logs [service]` - View logs (optional service: backend, frontend, mongo, postgres)
- `./dev.sh build` - Build development containers (with cache)
- `./dev.sh rebuild` - Rebuild development containers (no cache, when dependencies change)
- `./dev.sh clean` - Clean up containers and volumes
- `./dev.sh shell [service]` - Open shell in service container
- `./dev.sh test` - Run backend tests

#### Production Environment
- `./prod.sh up` - Start production environment
- `./prod.sh down` - Stop production environment
- `./prod.sh deploy` - Build and deploy production environment
- `./prod.sh logs [service]` - View production logs

#### Legacy Commands (Deprecated)
- `docker-compose build` - Build all containers (production)
- `docker-compose up -d` - Start all services in detached mode (production)
- `docker-compose down` - Stop all services

#### Development vs Production Differences
**Development Environment (`./dev.sh`):**
- ✅ Live file mounting - changes reflect immediately without rebuilds
- ✅ Auto-restart on file changes (nodemon for backend, hot reload for frontend)
- ✅ Development server for React (faster builds, better debugging)
- ✅ No need to rebuild containers for code changes
- ✅ Separate volumes to avoid conflicts with production

**Production Environment (`./prod.sh`):**
- 🏭 Optimized builds with nginx for frontend
- 🏭 Minified and optimized assets
- 🏭 Production-ready configuration
- 🏭 Stable, cacheable container images

### Testing
- `./dev.sh test` - Run backend tests in development container (recommended)
- `./dev.sh shell backend` then `npm test` - Interactive testing in container
- `docker exec -e NODE_ENV=test -e JWT_SECRET=test-jwt-secret backend-dev npm test` - Direct container test execution
- `cd backend && npm test` - Run backend tests locally
- `cd backend && npm run test:watch` - Run backend tests in watch mode
- `cd backend && npm run test:coverage` - Run backend tests with coverage
- `cd frontend && npm test` - Run frontend tests
- `cd frontend && npm run test:coverage` - Run frontend tests with coverage

### Linting
- `npm run lint` - Lint both frontend and backend
- `npm run lint:fix` - Auto-fix linting issues in both
- `cd backend && npm run lint:fix` - Fix backend linting only
- `cd frontend && npm run lint:fix` - Fix frontend linting only

### Discord Commands
- `docker-compose -f docker-compose.dev.yml exec -T backend npm run discord:deploy` - Deploy Discord slash commands (preferred in Docker)
- `cd backend && npm run discord:deploy` - Deploy Discord slash commands (local)
- `cd backend && npm run discord:register` - Register Discord commands
- `cd backend && npm run discord:list` - List Discord commands

**Note**: Global Discord slash commands take up to 1 hour to propagate across all servers. For immediate testing during development, consider guild-specific commands.

### Daily Digest and Analytics Commands
- `docker-compose -f docker-compose.dev.yml exec -T backend node -e "require('./services/dailyDigestService').generateUserDailyDigest('USER_ID')"` - Generate daily digest for specific user
- `curl -X POST localhost:5000/api/summaries/daily-digest/generate -H "Authorization: Bearer TOKEN"` - Generate daily digest via API
- `curl -X POST localhost:5000/api/summaries/daily-digest/trigger-all -H "Authorization: Bearer TOKEN"` - Generate digests for all users (admin)

### Development
- `cd backend && npm run dev` - Start backend with nodemon
- `cd frontend && npm start` - Start frontend dev server
- `node download-ca.js` - Download PostgreSQL CA certificate

## Architecture Overview

### Dual Database System
- **MongoDB**: Primary database for users, posts, pod metadata, and authentication
- **PostgreSQL**: Default storage for chat messages with user/pod references for joins
- **Smart Synchronization**: Automatic user/pod sync between databases as needed
- **Message Persistence**: All chat messages persist across page refreshes via PostgreSQL
- **Graceful Fallback**: System falls back to MongoDB if PostgreSQL connection fails
- Both databases are required for full functionality

### Service Structure
- **Frontend**: React.js with Material-UI on port 3000
- **Backend**: Node.js/Express API on port 5000  
- **Real-time**: Socket.io for chat and live updates

### Key Backend Services
- `services/discordService.js` - Discord bot integration
- `services/summarizerService.js` - AI-powered content summarization using Gemini
- `services/chatSummarizerService.js` - Advanced chat analysis with enhanced analytics
- `services/dailyDigestService.js` - Intelligent daily newsletter generation
- `services/schedulerService.js` - Background tasks and periodic jobs
- `services/integrationService.js` - Third-party service management
- `services/commonlyBotService.js` - Bot user management for automated posting

### Database Models
- **MongoDB models**: `models/User.js`, `models/Post.js`, `models/Pod.js` (primary)
- **PostgreSQL models**: `models/pg/Pod.js`, `models/pg/Message.js` (default for chat)
- **Message Storage**: All chat messages default to PostgreSQL with MongoDB fallback
- **User Sync**: Active users automatically synchronized to PostgreSQL for message joins
- **Discord models**: `models/DiscordIntegration.js`, `models/DiscordMessageBuffer.js`

### Route Structure
- `/api/auth` - User authentication (MongoDB)
- `/api/pods` - Chat pod management (dual DB: MongoDB primary, PostgreSQL sync)
- `/api/messages` - Message handling (PostgreSQL default, MongoDB fallback)
- `/api/discord` - Discord integration endpoints (commonly-bot uses PostgreSQL)
- `/api/integrations` - Third-party service management

### Environment Variables
Key required variables:
- `MONGO_URI` - MongoDB connection
- `PG_*` variables - PostgreSQL connection details
- `JWT_SECRET` - Authentication secret
- `DISCORD_BOT_TOKEN` - Discord bot integration
- `GEMINI_API_KEY` - AI summarization service

### Testing Strategy
- Backend uses Jest with MongoDB Memory Server and pg-mem for isolated testing
- Frontend uses React Testing Library
- Integration tests cover dual database scenarios
- Discord functionality has dedicated test files

### Data Integrity Notes
- Chat summaries include validation to prevent message count corruption (>10,000 messages/hour flagged)
- Pod name validation ensures summaries are properly attributed
- Corrupted summaries can be cleaned using MongoDB queries to remove entries with excessive message counts
- Automatic garbage collection removes summaries older than 24 hours (except daily digests)

## Intelligent Summarization & Daily Digest System

### Overview
Commonly features a sophisticated AI-powered summarization system that transforms basic chat activity into intelligent community insights, daily newsletters, and user engagement analytics.

### Architecture Layers

#### Layer 1: Hourly Data Collection
- **Real-time Capture**: Messages stored in PostgreSQL, posts in MongoDB
- **Hourly Summarization**: AI analyzes last hour's activity every hour at minute 0
- **Basic Summaries**: Simple 2-3 sentence summaries for immediate display
- **Garbage Collection**: Automatic cleanup of summaries >24 hours old

#### Layer 2: Enhanced Analytics (Behind the Scenes)
- **Timeline Events**: AI identifies key moments (topic shifts, heated discussions, new participants)
- **Quote Extraction**: Notable quotes with sentiment analysis and context
- **Insight Detection**: Trends, consensus building, disagreements, revelations
- **Atmosphere Analysis**: Overall sentiment, energy level, engagement quality, community cohesion
- **Participation Patterns**: User roles, engagement scores, activity patterns

#### Layer 3: Daily Digest Intelligence
- **User Personalization**: Digests based on subscribed pods and activity preferences
- **Cross-Conversation Insights**: Patterns and connections across multiple pods
- **Newsletter Generation**: Friendly, engaging daily summaries with markdown formatting
- **Subscription Management**: User preferences for frequency, content types, delivery times

### Data Structure Enhancement

#### Enhanced Summary Schema
```javascript
{
  type: 'posts' | 'chats' | 'daily-digest',
  content: 'User-facing summary text',
  analytics: {
    timeline: [/* Key events with timestamps and intensity scores */],
    quotes: [/* Notable quotes with sentiment and context */],
    insights: [/* AI-detected trends and patterns */],
    atmosphere: {/* Community mood and engagement metrics */},
    participation: {/* User engagement patterns and roles */}
  }
}
```

#### User Digest Preferences
```javascript
{
  subscribedPods: [/* ObjectIds of followed pods */],
  digestPreferences: {
    enabled: true,
    frequency: 'daily' | 'weekly' | 'never',
    deliveryTime: '06:00', // UTC
    includeQuotes: true,
    includeInsights: true,
    includeTimeline: true,
    minActivityLevel: 'low' | 'medium' | 'high'
  }
}
```

### AI Prompt Engineering

#### Basic Summarization
- Simple, engaging 2-3 sentence summaries
- Focus on main topics and community interaction
- Conversational tone for immediate consumption

#### Enhanced Analytics Extraction
- Structured JSON responses with detailed analysis
- Timeline event detection with intensity scoring
- Quote extraction with sentiment classification
- Insight identification with confidence scores
- Atmosphere assessment across multiple dimensions

#### Daily Digest Generation
- Personalized newsletter creation
- Cross-pod pattern recognition
- Engaging markdown formatting
- Context-aware content prioritization

### Scheduling and Automation

#### Cron Jobs
- **Hourly (0 * * * *)**: Summary generation + garbage collection
- **Daily (0 6 * * *)**: Daily digest generation for all users
- **Daily (0 2 * * *)**: Deep cleanup of old summaries (30+ days)

#### Manual Triggers
- Individual user digest generation
- Bulk digest generation for all users
- Summary refresh with garbage collection
- Enhanced analytics on-demand

### API Endpoints

#### Summary Management
- `GET /api/summaries/latest` - Get latest hourly summaries
- `POST /api/summaries/trigger` - Manual summary generation with GC
- `GET /api/summaries/{type}` - Get summaries by type

#### Daily Digest System
- `GET /api/summaries/daily-digest` - Get user's latest digest
- `POST /api/summaries/daily-digest/generate` - Generate fresh digest
- `GET /api/summaries/daily-digest/history` - Get digest history
- `POST /api/summaries/daily-digest/trigger-all` - Generate for all users

### Performance Considerations

#### Caching Strategy
- **Display Layer**: Simple summaries shown to users immediately
- **Analytics Layer**: Rich data cached for daily digest generation
- **Garbage Collection**: Automatic cleanup prevents database bloat
- **User Subscriptions**: Efficient pod-based filtering for personalization

#### Scalability Design
- **Modular Services**: Separate services for different analysis types
- **Fallback Systems**: Graceful degradation when AI services fail
- **Data Validation**: Prevents corruption and ensures data quality
- **Background Processing**: Non-blocking summarization and digest generation

### Future Enhancements
- **Real-time Insights**: Live community pulse and trending topics
- **Advanced Analytics**: User journey analysis and community health metrics
- **Integration Expansion**: Support for more platforms beyond Discord
- **Machine Learning**: Improved insight detection and personalization
- **Email Delivery**: Automated email digest delivery system

### Discord Integration (Unified API Architecture)
- Full Discord bot with slash commands and automatic hourly sync
- **API Polling Architecture**: Direct Discord API calls (no webhook listeners)
- **Unified Internal API**: Both manual commands and automatic sync use same underlying methods
- Enhanced message filtering (excludes bots, empty content, applies time ranges)
- Command registration via scripts in `backend/scripts/`

#### Discord Bot Commands
- `/commonly-summary` - Shows latest summary from linked Commonly pod
- `/discord-status` - Shows integration status and auto-sync settings
- `/discord-enable` - Enables automatic hourly Discord→Commonly sync
- `/discord-disable` - Disables automatic hourly Discord→Commonly sync  
- `/discord-push` - Manual trigger for immediate Discord activity sync (last hour)

#### Unified Sync Architecture
**Both manual (`/discord-push`) and automatic (hourly) sync use the same method:**
- `DiscordService.syncRecentMessages(timeRangeHours)` - Unified API for Discord message processing
- Fetches messages via Discord API with comprehensive filtering
- Creates AI summaries using Gemini API
- Posts to Commonly pods via @commonly-bot
- Saves sync history to DiscordSummaryHistory

#### Integration Flow
1. **Commonly→Discord**: `/commonly-summary` command shows Commonly pod activity in Discord
2. **Discord→Commonly (Automatic)**: Hourly cron job fetches Discord messages and posts summaries to pods
3. **Discord→Commonly (Manual)**: `/discord-push` command triggers immediate sync
4. **Message Quality**: Advanced filtering excludes bot messages, empty content, and applies time-based filtering
5. **Commonly Bot**: Automated user (@commonly-bot) posts integration summaries to pods

#### Technical Architecture
**Hourly Scheduler Integration:**
```javascript
// Added to SchedulerService.runSummarizer() as Step 1
await SchedulerService.syncAllDiscordIntegrations();
```

**Message Filtering Logic:**
```javascript
const recentMessages = messages.filter(msg => {
  const isInTimeRange = msgTime >= timeAgo;
  const isHuman = !msg.author?.bot;           // Exclude Discord bots
  const hasContent = msg.content && msg.content.trim().length > 0;
  return isInTimeRange && isHuman && hasContent;
});
```

#### Command Deployment Notes
- Global slash commands take up to 1 hour to propagate across Discord servers
- Commands are deployed using `docker-compose -f docker-compose.dev.yml exec -T backend npm run discord:deploy`
- All environment variables (DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN, etc.) are configured in Docker environment
- For immediate testing, guild-specific commands can be implemented for faster deployment

#### Key Services
- `services/discordService.js` - Core Discord API integration with unified `syncRecentMessages()` method
- `services/discordCommandService.js` - Discord slash command handlers (uses unified API)
- `services/commonlyBotService.js` - Bot user management and pod posting
- `services/schedulerService.js` - Hourly Discord sync integration (`syncAllDiscordIntegrations()`)

#### Performance Optimizations
- **Reduced Memory Usage**: 815MB → 203MB (60% improvement) in development containers
- **API Polling**: Predictable hourly Discord API calls vs unpredictable webhook traffic
- **No Message Caching**: Direct API fetching eliminates complex message buffering
- **Enhanced Error Handling**: Proper fallbacks and logging for Discord API failures

For detailed technical documentation, see `docs/DISCORD_INTEGRATION_ARCHITECTURE.md`

## PostgreSQL Message Storage Implementation

### Current State (Updated)
- **All chat messages** now default to PostgreSQL storage
- **Message persistence** across page refreshes guaranteed
- **commonly-bot messages** stored in PostgreSQL (not MongoDB)
- **Real-time Socket.io** and API endpoints use PostgreSQL consistently

### Key Implementation Files
- `backend/controllers/messageController.js` - Uses PostgreSQL for all message operations
- `backend/services/commonlyBotService.js` - Bot messages stored in PostgreSQL
- `backend/server.js` - Socket.io uses PostgreSQL for message storage
- `backend/models/pg/Message.js` - PostgreSQL message model (ORDER BY created_at ASC)

### Message Flow
```javascript
1. User sends message (Socket.io or API)
   ↓
2. Check pod membership (MongoDB - authoritative)
   ↓  
3. Store message (PostgreSQL - default)
   ↓
4. Broadcast via Socket.io (real-time)
   ↓
5. Retrieve messages (PostgreSQL with user joins)
```

### Bot Integration
- **User Sync**: commonly-bot user automatically synced to PostgreSQL users table
- **Message Storage**: All Discord integration messages stored in PostgreSQL
- **Performance**: One-time user sync (checks if user exists before syncing)
- **Persistence**: Bot messages persist after refresh (showing "commonly-bot" not "Unknown User")

### Testing Message Persistence
1. Send a message in any pod
2. Refresh the browser page
3. Verify message still appears (stored in PostgreSQL)
4. Check message order is chronological (oldest first)
5. Trigger Discord integration and verify commonly-bot message persists

### Troubleshooting
- **PostgreSQL connection**: Check logs for "PostgreSQL connected successfully"
- **Message persistence**: If messages disappear, PostgreSQL connection may have failed
- **Unknown User**: User not synced to PostgreSQL users table
- **Message order**: Should be chronological (oldest first) via ORDER BY created_at ASC

### Related Documentation
- `docs/POSTGRESQL_MIGRATION.md` - Complete migration guide and architecture
- `docs/ARCHITECTURE.md` - Updated dual database architecture
- `docs/DISCORD.md` - Discord bot PostgreSQL integration details