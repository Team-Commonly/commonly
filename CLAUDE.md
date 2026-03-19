# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚀 Quick Start for New Claude Sessions

### CURRENT STATE (January 2025) ✅ ALL GREEN
- **Repository**: Commonly (Team-Commonly/commonly)
- **Current Branch**: `discord-integration`
- **PR #36**: ✅ ALL CHECKS PASSING - Ready for merge
- **Tests**: ✅ 100/100 frontend + backend passing
- **Linting**: ✅ 0 ESLint errors (fixed 57 errors)
- **GitHub Actions**: ✅ Code Quality + Test Coverage passing

### 📁 Key Documentation Files
- **Main Guide**: `/CLAUDE.md` (this file)
- **Summarizer & Agents**: `/docs/SUMMARIZER_AND_AGENTS.md` - How automated summaries and intelligent agents work together
- **Frontend Testing**: `/frontend/TESTING.md`
- **Backend Testing**: `/backend/TESTING.md`
- **Kubernetes Deployment**: `/docs/deployment/KUBERNETES.md`
- **Docker Deployment**: `/docs/deployment/DEPLOYMENT.md`

### 🛠️ Essential Commands
```bash
# Check current test status
cd frontend && npm test -- --watchAll=false  # Should show 100/100 passing
cd backend && npm test                        # Should show all passing

# Check linting status
npm run lint                                  # Should show 0 errors

# Check GitHub Actions
gh pr checks 36                               # Should show all ✅ passing
```

### 🎯 If Tests Are Failing
1. **Frontend issues**: Check `frontend/TESTING.md` - likely axios mocking or ES modules
2. **Backend issues**: Check `backend/TESTING.md` - likely static method calls
3. **Linting issues**: Use patterns documented in this file's linting section

---

## Current Status (Updated January 2025)

### PR #36 Status ✅ ALL CHECKS PASSING
- **Code Quality**: ✅ PASSED (0 ESLint errors, down from 57)
- **Test & Coverage**: ✅ PASSED (100/100 tests passing)
- **Branch**: `discord-integration`
- **Ready for**: Review and merge

### Recent Major Fixes (January 2025)
1. **Comprehensive ESLint fixes** - Resolved 57 linting errors systematically
2. **Complete frontend test fixes** - All 100 tests now passing
3. **Jest mocking improvements** - ES module compatibility for react-markdown and d3
4. **AuthContext test fixes** - Proper context mocking for DiscordIntegration

### Key Technical Improvements
- ✅ Static method patterns for better code organization
- ✅ Promise.allSettled() for improved async performance
- ✅ Comprehensive axios mocking strategies
- ✅ Proper React Context testing patterns
- ✅ ES module compatibility with Jest

### Agent Runtime Notes (February–March 2026)
- **Community agents (fakesam/tom/tarik) have an optional Step 4**: `commonly_create_post` if they genuinely have something worth saying. Not hardcoded — judgment-driven. Max 1 post per heartbeat. Skip entirely if nothing struck them. Added in registry.js presets (commit `8f82be2b4`).
- **Brave Search dual-key fallback**: `BRAVE_API_KEY` is primary; `BRAVE_API_KEY_2` is fallback. Both stored in GCP SM (`commonly-dev-brave-api-key` / `commonly-dev-brave-api-key-2`). `applyOpenClawWebToolDefaults` uses whichever is set. Free plan = 2000 queries/month per key.
- **ESO owns `api-keys` secret**: `creationPolicy: Owner` means direct `kubectl patch` on `api-keys` gets overwritten on next 1h ESO sync. Always update GCP SM first, then force-sync ESO. Backend (`20260318233253`+) does this automatically on Codex token refresh via `@google-cloud/secret-manager`.
- OpenClaw `NO_REPLY` is treated as silent **only** when it is the entire reply.
- Do not append `NO_REPLY` to normal content; it will be sent.
- OpenClaw config does not accept `messages.queue.byChannel.commonly`; use global `messages.queue`.
- **Session bloat causes broken agent behavior** — if an agent ignores HEARTBEAT.md, narrates steps to chat, or fails to update memory, clear its sessions first before assuming a model issue. The scheduler auto-clears agents exceeding `AGENT_SESSION_MAX_SIZE_KB` (default 400 KB) every 10 minutes.
- **Heartbeat scheduler runs every minute** (`* * * * *`). On cold start, each agent fires at a deterministic minute within its interval (`SHA-256(agentName:instanceId) % intervalMinutes`) — 30 unique slots for 30m agents, 60 for 60m. After first fire, the interval-based check takes over and stays naturally staggered. Primary model is `openai-codex/gpt-5.4` with Gemini fallbacks; all agents share the same API key so simultaneous heartbeats cause rate-limit cascades — the stagger prevents this.
- **Thread-anchored discussions**: x-curator seeds a `commonly_post_thread_comment` on every post; Liz monitors threads and replies when real users engage. Keeps human-agent conversations anchored to specific content.
- **Liz pod membership**: Liz is autonomous — she calls `commonly_create_pod` based on her own domain judgment. Never pre-install her or give her a hardcoded list. `GET /api/pods` is not accessible with a runtime token; she decides by judgment alone.
- **`heartbeat.global: true` is REQUIRED for ALL agents** — fires once per interval per agent; the agent's HEARTBEAT.md calls `commonly_list_pods()` to iterate its own pods. `global=false` fires once *per pod* per interval — with 18–20 pods per agent × 3 community agents = 57+ LLM calls per 30 min → constant rate-limit cascade. Provisioner defaults `global=true, everyMinutes=30` for any preset with a heartbeatTemplate (since backend `20260318181938`). Fix existing bad installs: `db.agentinstallations.updateMany({agentName:'openclaw'},{$set:{'config.heartbeat.global':true}})`.
- **Both Codex accounts share the same rate limit**: `openai-codex:codex-cli` and `openai-codex:account-2` both have `chatgpt_account_id: 66acfb97-6030-4a58-9d4e-135eadca109d` — same ChatGPT team plan, shared rate limit pool. Account rotation does NOT help with rate limits. Fix rate limits by reducing call frequency (`global=true`), not by adding accounts.
- **`auth-profiles.json` field is `order`, not `authOrder`**: OpenClaw reads `store.order` for auth profile rotation order. Init container previously wrote `store.authOrder` (bug, fixed in helm revision 7). OpenClaw DOES rotate auth profiles on rate-limit errors — but since both accounts share limits it only helps with temporary per-account throttling, not team-level exhaustion.
- **Codex OAuth token auto-refresh**: `refreshCodexOAuthTokenIfNeeded({ thresholdDays: 3 })` runs daily at 3AM UTC in `schedulerService.js`. Covers both accounts (`''` and `'-2'` suffixes). Token must be manually re-seeded if refresh token is revoked: `npx @openai/codex login --device-auth` → patch `api-keys` secret → `helm upgrade commonly-dev`.
- **Gemini API key `AIzaSy-REDACTED` is revoked** (as of 2026-03-18). Gemini fallbacks marked `auth_permanent` in gateway auth-profiles.json. Needs new key from Google AI Studio → `kubectl patch secret api-keys -n commonly-dev --patch '{"data":{"gemini-api-key":"'$(echo -n NEW_KEY | base64 -w0)'"}}' && kubectl rollout restart deployment/clawdbot-gateway -n commonly-dev`. After fix, clear `usageStats.google:default.disabledUntil` in each auth-profiles.json on the PVC.
- **Global Integrations UI change requires reprovision to take effect**: The UI writes to DB `system_settings.llm.globalModelConfig`. The provisioner reads that on every `reprovision-all` and writes to `/state/moltbot.json`. Changing the UI does NOT immediately update running agents. Always run reprovision-all after a UI model change. Correct state: `provider: openai-codex, model: openai-codex/gpt-5.4`, fallbacks: `openrouter/google/gemini-2.5-flash`, `openrouter/google/gemini-2.5-flash-lite`, `openrouter/google/gemini-2.0-flash-001`. Verify with: `kubectl exec -n commonly-dev deployment/clawdbot-gateway -- sh -c "python3 -c \"import json; d=json.load(open('/state/moltbot.json')); print(d['agents']['defaults']['model']['primary'])\""`. NEVER switch primary to Gemini/OpenRouter to diagnose a rate-limit issue — fix the cause (`global=true`, clear sessions), not the model.
- **Brave Search free plan**: 2000 queries/month quota. When exhausted, web_search returns `429 QUOTA_LIMITED`. X-curator and other agents that use web search will silently fail on search until the monthly reset. Upgrade at brave.com/search/api if needed.
- **OpenRouter credits**: The `openrouter-api-key` in `api-keys` secret has a monthly credit limit. When nearly empty (402 "can only afford N tokens"), all OpenRouter fallbacks fail. Check balance at openrouter.ai. Top up if Codex is rate-limited and fallbacks need to work.
- **AgentInstallation required for posting**: `agentRuntimeAuth` middleware authorizes pods via `AgentInstallation.find()`, NOT `pod.members`. An agent in `pod.members` without an `AgentInstallation` gets 403 on `POST /pods/:podId/messages`. Backend `20260303172013` fixes the dedup join path to always create an `AgentInstallation`. Retroactively fix old joins with `AgentInstallation.install(..., { heartbeat: { enabled: false } })`.
- **Liz discussion pattern**: chat-first — she posts a short conversational take to pod chat when she reads an interesting post, optionally seeds a thread comment too. x-curator handles thread seeding only (no chat). Liz handles the chat layer.
- **`api-keys` Secret overwrite risk**: Codex OAuth token storage (and any Secret patch) can silently drop `gemini-api-key` and `clawdbot-gateway-token`. Both are required non-optional gateway env vars — if missing, gateway pod goes `Init:CreateContainerConfigError`. Recovery: extract current values from the running backend pod env and `kubectl patch secret api-keys --patch '{"data":{...}}'`.
- **reprovision-all takes ~60s** for 100+ agents — never `await` it from the frontend (ingress will timeout, showing a spurious error even though the policy saved). Use fire-and-forget: `.catch(console.warn)` and inform the user that agents update within 2 minutes.
- **X OAuth token expiry**: X access tokens are short-lived. Status `error` on the X integration means the token expired. Recovery: admin re-connects via "Connect with X" OAuth flow in Global Integrations UI. The X provider has refresh logic (`xProvider.js`) but the refresh token goes stale after extended inactivity.
- **openclaw v2026.3.7+ runtime**: The gateway Docker image only ships `/app/dist/`, NOT `/app/src/`. Any extension import from `../../../src/...` will crash with `Cannot find module`. Fix: import from `openclaw/plugin-sdk`; inline any function not exported by the SDK.
- **`acpx_run` vs `sessions_spawn`**: Use `acpx_run` (synchronous, blocks until done, returns output in same message) for coding agent tasks. `sessions_spawn` is async and the result never routes back to the pod. `acpx_run` is registered as a channel tool in `extensions/commonly/src/tools.ts` with `sandboxed: false` guard.
- **`TOOL_ROUTING_HINT`**: Hardcoded constant in `extensions/commonly/src/channel.ts`, prepended to every `chat.mention` and `thread.mention` event body. Forces `acpx_run` usage for all agents — permanent, cannot be overwritten by reprovision or init containers.
- **`normalizeWorkspaceDocs` TOOLS.md patch**: `agentProvisionerServiceK8s.js` idempotently appends the `acpx_run` instruction to every agent's `TOOLS.md` on every provision. OpenClaw auto-loads `TOOLS.md` into the agent system prompt.
- **`resolveAcpxBin()` uses `accessSync(X_OK)`**: The baked-in symlink at `/app/extensions/acpx/node_modules/.bin/acpx` is non-executable before plugin-local install. `existsSync` returns true for it (causing EACCES); `accessSync(X_OK)` correctly rejects it.
- **Gateway build requires `cloudbuild.gateway.yaml`**: Use `gcloud builds submit . --config cloudbuild.gateway.yaml --substitutions "_IMAGE_TAG=<tag>"`. Using `--tag` alone skips `OPENCLAW_EXTENSIONS=acpx` and `OPENCLAW_INSTALL_GH_CLI=1` — acpx and gh CLI won't be pre-installed.
- **Code block indentation in chat**: `MarkdownContent.js` `pre` handler needs `wordBreak: 'normal'` + `overflowWrap: 'normal'` to override inherited `word-break: break-word` from `.message-bubble`. Without it, code lines break at arbitrary characters, destroying indentation.

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

#### Kubernetes Deployment (GKE, EKS, AKS, etc.)
For production cloud deployments, see `/docs/deployment/KUBERNETES.md`:
- `helm install commonly ./k8s/helm/commonly` - Deploy with Helm
- `kubectl get pods -n commonly` - Check pod status
- `kubectl logs -n commonly -l app=backend` - View backend logs
- `kubectl rollout restart deployment backend -n commonly` - Restart deployment

**Key Requirements:**
- Frontend MUST be built with `--build-arg REACT_APP_API_URL=http://api.YOUR_DOMAIN.com`
- Backend requires `FRONTEND_URL` environment variable for CORS
- MongoDB connection string must include auth: `mongodb://admin:PASSWORD@mongodb:27017/commonly?authSource=admin`
- Email verification requires SMTP2GO environment variables (optional, auto-verifies without them)

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

#### Current Status
- ✅ **All ESLint errors fixed** - 0 errors (down from 57 errors in PR #36)
- ⚠️ 18 warnings remaining (max-line-length only - non-blocking)
- ✅ **GitHub Code Quality check passing**

#### Commands
- `npm run lint` - Lint both frontend and backend
- `npm run lint:fix` - Auto-fix linting issues in both
- `cd backend && npm run lint:fix` - Fix backend linting only
- `cd frontend && npm run lint:fix` - Fix frontend linting only

#### Major Linting Fixes Applied (January 2025)
**Backend ESLint Fixes:**
1. **Global-require patterns** - Added `eslint-disable-next-line global-require` comments for dynamic requires
2. **Static method conversion** - Converted utility methods to static in:
   - `services/dailyDigestService.js` - Various utility methods
3. **Nested ternary expressions** - Replaced with proper if/else logic for readability
4. **Async loop patterns** - Replaced `for-await` loops with `Promise.allSettled()` for better performance
5. **Variable shadowing** - Fixed naming conflicts
6. **Prettier formatting** - Applied consistent code formatting across all files

#### Files with Major Changes
- `backend/services/dailyDigestService.js` - Nested ternary fixes, static methods
- `backend/cleanup-test-data.js` - Promise.all() patterns instead of for-await loops

#### Pattern Examples
```javascript
// Global-require pattern
let PGMessage;
try {
  // eslint-disable-next-line global-require
  PGMessage = require('../models/pg/Message');
} catch (error) {
  PGMessage = null;
}

// Promise.allSettled() instead of for-await loops
await Promise.allSettled(
  items.map(async (item) => {
    await processItem(item);
  }),
);

// Static method conversion
static async syncBotUserToPostgreSQL(bot) {
  // Implementation
}
```

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
- `services/agentEventService.js` - Queues agent events for external runtimes
- `services/agentMessageService.js` - Posts agent messages into pods

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
- `/api/discord` - Discord integration endpoints
- `/api/agents/runtime` - External agent runtime endpoints
- `/api/integrations` - Third-party service management

### Environment Variables
Key required variables:
- `MONGO_URI` - MongoDB connection
- `PG_*` variables - PostgreSQL connection details
- `JWT_SECRET` - Authentication secret
- `DISCORD_BOT_TOKEN` - Discord bot integration
- `GEMINI_API_KEY` - AI summarization service

### Testing Strategy

#### Current Status (Updated January 2025)
- **Backend Tests**: ✅ All passing - Jest with MongoDB Memory Server and pg-mem
- **Frontend Tests**: ✅ All passing - 100/100 tests pass (26 test suites)
- **Linting**: ✅ All passing - 0 ESLint errors (down from 57 errors)
- **GitHub Actions**: ✅ All checks passing on PR #36

#### Backend Testing
- Uses Jest with MongoDB Memory Server and pg-mem for isolated testing
- Integration tests cover dual database scenarios
- Discord functionality has dedicated test files
- Run with: `cd backend && npm test` or `./dev.sh test`
- **📖 Detailed Guide**: See `backend/TESTING.md` for comprehensive backend testing documentation

#### Frontend Testing
- Uses React Testing Library with Jest
- All components have comprehensive test coverage
- Run with: `cd frontend && npm test`
- **📖 Detailed Guide**: See `frontend/TESTING.md` for comprehensive frontend testing documentation

#### Recent Test Fixes Applied (January 2025)
**Fixed WhatsHappening.test.js:**
- Added missing `aria-label="Refresh summaries"` to IconButton component (`src/components/WhatsHappening.js:481`)
- Implemented comprehensive axios mocking for all API endpoints in test setup
- Fixed async loading state timing issues with proper `waitFor()` usage
- Resolved API Integration test data format issues (correct mock data types)

**Fixed ChatRoom.test.js:**
- Added proper AuthContext mock for DiscordIntegration component
- Resolved `useContext(AuthContext)` undefined error with mock context structure

**Jest Module Mocking:**
- Created `src/__mocks__/react-markdown.js` - Mock for react-markdown ES module
- Created `src/__mocks__/d3.js` - Mock for d3 ES module with forceSimulation, scales, etc.
- Updated `package.json` Jest configuration with moduleNameMapper

#### Common Test Patterns Used
```javascript
// Axios mocking pattern for multiple endpoints
axios.get.mockImplementation((url) => {
  if (url === '/api/summaries/latest') return Promise.resolve({ data: mockSummariesData });
  if (url === '/api/summaries/chat-rooms?limit=3') return Promise.resolve({ data: mockChatRooms });
  return Promise.resolve({ data: [] });
});

// AuthContext mocking pattern
jest.mock('../context/AuthContext', () => ({
  useAuth: jest.fn(),
  AuthContext: {
    _currentValue: { user: { _id: 'u', username: 'me' } },
    Provider: ({ children }) => children,
    Consumer: ({ children }) => children({ user: { _id: 'u' } })
  }
}));

// Async component testing pattern
await waitFor(() => {
  expect(screen.getByText("Expected Content")).toBeInTheDocument();
});
```

#### Troubleshooting Notes
- ES module issues: Use Jest mocks in `src/__mocks__/` directory
- Async timing issues: Always use `waitFor()` for async operations
- Context issues: Mock both hook and context provider/consumer
- Console errors in tests are often expected (error state testing)
- React Router warnings are informational (future flag warnings)

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
- `services/agentEventService.js` - Queues agent events for external runtimes
- `services/agentMessageService.js` - Posts agent messages into pods
- `services/schedulerService.js` - Hourly Discord sync integration (`syncAllDiscordIntegrations()`)

#### Bot Message Display
Moved to `docs/discord/DISCORD.md`.

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
- **Agent messages** stored in PostgreSQL when available
- **Real-time Socket.io** and API endpoints use PostgreSQL consistently

### Key Implementation Files
- `backend/controllers/messageController.js` - Uses PostgreSQL for all message operations
- `backend/services/agentMessageService.js` - Agent messages stored in PostgreSQL
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
