# Clawdbot (Moltbot) Integration

Clawdbot is a personal agent runtime that runs on a user's machine or a
managed host. In Commonly we treat it as an **external agent**.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Commonly Platform                           │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌──────────────────────┐    ┌─────────────────┐ │
│  │  AgentsHub  │────│  ClawdbotConfigPanel │    │ /api/health/    │ │
│  │    (UI)     │    │  - Gateway status    │────│   clawdbot      │ │
│  └─────────────┘    │  - Runtime tokens    │    └─────────────────┘ │
│                     └──────────────────────┘                        │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Agent Runtime API                            ││
│  │  POST /api/agents/runtime/events         (poll for events)     ││
│  │  POST /api/agents/runtime/pods/:id/messages (post responses)   ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                               │
                   ┌───────────┴───────────┐
                   │                       │
           ┌───────▼───────┐       ┌───────▼───────┐
           │ Clawdbot      │       │ Clawdbot      │
           │ Bridge        │──────▶│ Gateway       │
           │ (polls events)│       │ (AI runtime)  │
           └───────────────┘       └───────┬───────┘
                                           │
                             ┌─────────────┴─────────────┐
                             │    Skills & Channels      │
                             ├───────────────────────────┤
                             │  Skills:                  │
                             │  - commonly (curl-based)  │
                             │  - weather, github, etc   │
                             │                           │
                             │  Channels:                │
                             │  - Discord                │
                             │  - Telegram               │
                             │  - Slack                  │
                             └───────────────────────────┘
```

## How it connects

1. **Clawdbot -> Commonly (via Skills)**
   - The `commonly` skill provides curl-based API access
   - Clawdbot reads the skill and executes commands when relevant
   - Uses `COMMONLY_API_TOKEN` for authentication

2. **Commonly -> Clawdbot (via Bridge)**
   - Clawdbot Bridge polls Commonly for agent events
   - Sends events to Clawdbot Gateway for AI processing
   - Posts responses back to Commonly pods

## Local Docker Setup (dev)

We ship optional Clawdbot containers in `docker-compose.dev.yml` under the
`clawdbot` profile.

### Quick Start

```bash
# Start all Clawdbot services
./dev.sh clawdbot up

# View gateway logs
docker logs clawdbot-gateway-dev --tail 50

# Check skill status
docker exec clawdbot-gateway-dev node dist/index.js skills list | grep commonly

# Restart services
./dev.sh clawdbot restart

# Stop services
./dev.sh clawdbot down
```

### Services

| Service | Description |
|---------|-------------|
| `clawdbot-gateway` | AI runtime with skills and channel support |
| `clawdbot-cli` | Interactive CLI for direct Clawdbot access |
| `clawdbot-bridge` | Polls Commonly events, calls gateway, posts responses |

### State Paths

- `external/clawdbot-state/config/` -> `/home/node/.clawdbot`
- `external/clawdbot-state/workspace/` -> `/home/node/clawd`
- `external/clawdbot-state/config/skills/` -> Custom skills directory

## Configuration

### moltbot.json

The main configuration file lives at `external/clawdbot-state/config/moltbot.json`:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "google/gemini-2.0-flash" },
      "maxConcurrent": 4,
      "subagents": { "maxConcurrent": 8 }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "auth": { "token": "your-gateway-token" },
    "controlUi": { "allowInsecureAuth": true },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "groupPolicy": "allowlist",
      "streamMode": "partial"
    },
    "discord": {
      "enabled": true,
      "token": "${DISCORD_BOT_TOKEN}",
      "groupPolicy": "open",
      "guilds": {
        "*": {
          "requireMention": true
        }
      }
    },
    "slack": {
      "mode": "socket",
      "webhookPath": "/slack/events",
      "enabled": true,
      "botToken": "${SLACK_BOT_TOKEN}",
      "appToken": "${SLACK_APP_TOKEN}",
      "userTokenReadOnly": true,
      "groupPolicy": "open"
    }
  }
}
```

### Discord Configuration

**Important:** Clawdbot uses a **separate Discord bot** from the Commonly backend to avoid conflicts with slash commands.

| Bot | Purpose | Env Variables |
|-----|---------|---------------|
| Commonly Bot | Slash commands (`/commonly-summary`, `/discord-push`) | `DISCORD_CLIENT_ID`, `DISCORD_BOT_TOKEN` |
| Clawdbot Bot | AI agent for natural language chat | `CLAWDBOT_DISCORD_CLIENT_ID`, `CLAWDBOT_DISCORD_BOT_TOKEN` |

**Mention-only mode:** By default, Clawdbot only responds when @mentioned in servers:
```json
"guilds": {
  "*": {
    "requireMention": true
  }
}
```

**Required Discord Intents:** Enable these in [Discord Developer Portal](https://discord.com/developers) -> Bot -> Privileged Gateway Intents:
- ✅ **Message Content Intent** - Required to read message content
- ✅ **Server Members Intent** - Required for user lookups

**Error 4014 (Disallowed Intents):** If you see this error, enable the intents above.

### Slack Configuration

**Socket Mode:** Clawdbot uses Slack Socket Mode for real-time events (no public webhook needed).

**Required Slack App Setup:**

1. **Enable Socket Mode** in [Slack API](https://api.slack.com) -> Your App -> Socket Mode
2. **Event Subscriptions** - Subscribe to bot events:
   - `message.channels` - Messages in public channels
   - `message.groups` - Messages in private channels
   - `message.im` - Direct messages
   - `app_mention` - When bot is @mentioned
3. **OAuth Scopes** - Add these bot token scopes:
   - `channels:history` - View messages in public channels
   - `channels:read` - View basic channel info
   - `chat:write` - Send messages
   - `groups:history` - View messages in private channels
   - `im:history` - View direct messages
   - `app_mentions:read` - Read @mentions
4. **Reinstall App** after adding scopes (OAuth & Permissions -> Reinstall to Workspace)
5. **Invite bot to channel** with `/invite @BotName`

### Commonly Integration via Skills

The `commonly` skill provides curl-based API access to Commonly pods. This approach:
- Uses the `COMMONLY_API_TOKEN` environment variable
- Requires no additional npm packages or MCP setup
- Works immediately with the existing Docker configuration

**Skill location:** `external/clawdbot-state/config/skills/commonly/SKILL.md`

**Available operations:**
- List pods - Get all accessible pods
- Search pod context - Hybrid vector + keyword search
- Get pod context - Structured context with memory and skills
- Get messages - Recent chat messages
- Post message - Send messages to pod chat
- Get pod info - Detailed pod information
- Get announcements - Pod announcements

#### Using the Skill

Skills work through **natural language** - Clawdbot reads the skill documentation and executes curl commands when you ask about Commonly-related tasks.

**Example prompts in Discord/Telegram/Slack:**
```
"What pods do I have access to in Commonly?"
"List my Commonly pods"
"Search the Engineering pod for deployment docs"
"Post 'Task completed!' to the Support pod"
```

#### Verifying the Skill

```bash
# Check skill status
docker exec clawdbot-gateway-dev node dist/index.js skills list | grep commonly
# Should show: ✓ ready │ 🫂 commonly

# Check required env var
docker exec clawdbot-gateway-dev printenv COMMONLY_API_TOKEN
```

### Environment Variables

Pass credentials via docker-compose or `.env`:

| Variable | Description |
|----------|-------------|
| `CLAWDBOT_GATEWAY_TOKEN` | Gateway authentication token |
| `CLAWDBOT_BRIDGE_TOKEN` | Runtime token for bridge (from UI) |
| `GEMINI_API_KEY` | LLM API key for Clawdbot responses |
| `ANTHROPIC_API_KEY` | Alternative LLM provider |
| `COMMONLY_API_URL` | Commonly backend URL (default: `http://backend:5000`) |
| `COMMONLY_API_TOKEN` | Runtime token for Commonly skill |
| `CLAWDBOT_DISCORD_CLIENT_ID` | Clawdbot Discord application ID (separate from Commonly) |
| `CLAWDBOT_DISCORD_BOT_TOKEN` | Clawdbot Discord bot token (separate from Commonly) |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-*`) |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-*`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |

**Note:** Clawdbot uses separate Discord credentials (`CLAWDBOT_DISCORD_*`) to avoid conflicts with the Commonly backend's slash commands.

### Getting Channel Credentials

| Channel | Where to get tokens |
|---------|-------------------|
| Discord | [Discord Developer Portal](https://discord.com/developers) -> Bot token |
| Slack | [Slack API](https://api.slack.com) -> Bot User OAuth Token |
| Telegram | [@BotFather](https://t.me/botfather) on Telegram |

## Troubleshooting

### Bot typing but no response

**Cause:** LLM API rate limits (HTTP 429 RESOURCE_EXHAUSTED)

**Symptoms:**
- Bot shows typing indicator
- No message is sent
- Session logs show empty responses

**Debug:**
```bash
# Check session logs for errors
docker exec clawdbot-gateway-dev tail -50 \
  /home/node/.clawdbot/agents/main/sessions/*.jsonl | grep -i error

# Check gateway logs
docker logs clawdbot-gateway-dev --tail 100 | grep -i "429\|exhausted\|error"
```

**Solutions:**
1. **Wait** - Free tier quotas reset after some time
2. **Switch model** - Use `anthropic/claude-sonnet-4-20250514` if you have `ANTHROPIC_API_KEY`
3. **Upgrade API** - Get a paid API key with higher limits

### Skill shows "missing"

**Cause:** Required dependencies not available

**Debug:**
```bash
# List skills and check status
docker exec clawdbot-gateway-dev node dist/index.js skills list

# Check required binaries
docker exec clawdbot-gateway-dev which curl

# Check required env vars
docker exec clawdbot-gateway-dev printenv COMMONLY_API_TOKEN
```

### Channel not connecting

**Debug:**
```bash
# Check channel status in logs
docker logs clawdbot-gateway-dev 2>&1 | grep -E "(discord|telegram|slack)"

# Verify tokens are set
docker exec clawdbot-gateway-dev printenv | grep -E "(DISCORD|TELEGRAM|SLACK).*TOKEN"
```

### Discord Error 4014 (Disallowed Intents)

**Cause:** Message Content Intent or Server Members Intent not enabled.

**Fix:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your Clawdbot application
3. Go to **Bot** -> **Privileged Gateway Intents**
4. Enable:
   - ✅ Message Content Intent
   - ✅ Server Members Intent
5. Save changes and restart Clawdbot

### Slack not receiving messages

**Symptoms:**
- Socket Mode connected (no warning in logs)
- Bot appears online in Slack
- Messages in channel are not processed

**Checklist:**

1. **Bot invited to channel?**
   ```
   /invite @YourBotName
   ```

2. **Event subscriptions configured?**
   - Go to [Slack API](https://api.slack.com) -> Your App -> Event Subscriptions
   - Enable Events
   - Subscribe to bot events:
     - `message.channels`
     - `message.groups`
     - `message.im`
     - `app_mention`

3. **OAuth scopes sufficient?**
   - Go to OAuth & Permissions -> Bot Token Scopes
   - Add: `channels:history`, `channels:read`, `chat:write`, `groups:history`, `im:history`, `app_mentions:read`

4. **App reinstalled after scope changes?**
   - Go to OAuth & Permissions -> Reinstall to Workspace
   - Reinvite bot to channels after reinstall

5. **Socket Mode enabled?**
   - Go to Socket Mode -> Enable Socket Mode
   - Ensure you have an App-Level Token (`xapp-*`)

**Debug:**
```bash
# Check Slack connection status
docker logs clawdbot-gateway-dev 2>&1 | grep -i slack

# Verify tokens
docker exec clawdbot-gateway-dev printenv | grep SLACK
```

## UI Components

### ClawdbotConfigPanel

Located in `frontend/src/components/agents/ClawdbotConfigPanel.js`, this panel
appears in the AgentsHub when configuring the `clawdbot-bridge` agent:

- **Gateway Status**: Shows if Clawdbot gateway is connected
- **Runtime Tokens**: Generate tokens for external Clawdbot instances
- **Config Snippet**: Copy-paste moltbot.json configuration
- **Active Connections**: List and revoke existing tokens

### Health Endpoint

`GET /api/health/clawdbot` returns gateway connectivity status:

```json
{
  "status": "connected",
  "gateway": "http://clawdbot-gateway:18789",
  "version": "1.0.0",
  "channels": ["discord", "telegram", "slack"]
}
```

## Agent Bootstrap

Agents are auto-registered on backend startup from manifest files in
`external/commonly-agent-services/`:

```
external/commonly-agent-services/
├── commonly-bot/
│   ├── index.js          # Agent runtime code
│   └── manifest.json     # Agent definition
└── clawdbot-bridge/
    ├── index.js          # Bridge polling logic
    └── manifest.json     # Agent definition
```

## Clawdbot Bridge Flow

1. Bridge polls `GET /api/agents/runtime/events` for pending events
2. For each event, bridge calls Clawdbot gateway `/v1/chat/completions`
3. Gateway processes with configured model + skills
4. Bridge posts response via `POST /api/agents/runtime/pods/:id/messages`
5. Bridge acknowledges event via `POST /api/agents/runtime/events/:id/ack`

## Commonly as a Channel

Commonly pods now work as a full **channel** for Clawdbot, similar to Discord/Slack/Telegram.
Users can `@clawdbot-bridge` in any pod chat to directly interact with the AI agent.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Commonly Pod Chat                            │
├─────────────────────────────────────────────────────────────────────┤
│  User: @clawdbot-bridge what are the team's priorities?             │
│                                                                      │
│  [AgentMentionService detects @mention]                             │
│                         ↓                                            │
│  [Creates chat.mention event with payload]                          │
│                         ↓                                            │
│  [Clawdbot Bridge polls event]                                      │
│                         ↓                                            │
│  [Bridge fetches full context via Context API]                      │
│    - Pod memory (MEMORY.md)                                         │
│    - Relevant skills (task-matched)                                 │
│    - Recent summaries                                               │
│    - Relevant assets (hybrid vector search)                         │
│    - Recent conversation history                                    │
│                         ↓                                            │
│  [Bridge calls Clawdbot Gateway with context]                       │
│                         ↓                                            │
│  [Posts context-aware response to pod]                              │
│                                                                      │
│  Clawdbot: Based on the recent team discussion, the priorities are: │
│  1. API refactoring (mentioned 5 times this week)                   │
│  2. Documentation updates (skill: "docs-update" detected)           │
│  3. Performance testing (from yesterday's summary)                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Context API Integration

The bridge now uses Commonly's full Context API (`/api/v1/context/:podId`) which provides:

| Feature | Description |
|---------|-------------|
| **Pod Memory** | MEMORY.md curated long-term memory |
| **Skills** | Auto-synthesized skills from pod activity |
| **Assets** | Relevant docs, links, threads via hybrid search |
| **Summaries** | Recent hourly chat summaries |
| **Conversation** | Last 10-15 messages for context |

### Configuration

Environment variables for context control:

```env
# Enable/disable context features
CLAWDBOT_INCLUDE_MEMORY=true      # Include MEMORY.md
CLAWDBOT_INCLUDE_SKILLS=true      # Include synthesized skills
CLAWDBOT_INCLUDE_SUMMARIES=true   # Include recent summaries

# Token budget for context
CLAWDBOT_MAX_CONTEXT_TOKENS=4000  # Max tokens for context assembly
```

### Usage Examples

**Ask about pod activity:**
```
@clawdbot-bridge what happened in this pod today?
```
*Uses recent summaries to provide activity overview*

**Get skill-based help:**
```
@clawdbot-bridge how do we deploy to production?
```
*Uses task-matched skills and search to find deployment docs*

**Reference pod memory:**
```
@clawdbot-bridge what are our team conventions?
```
*Uses MEMORY.md for long-term curated knowledge*

**Context-aware conversation:**
```
User1: We need to update the API docs
User2: @clawdbot-bridge can you help with that?
```
*Includes conversation history for context*

## Commonly Memory Skill

The `commonly-memory` skill enables Clawdbot to sync pod context to its own MEMORY.md.

### Skill Location

`external/clawdbot-state/config/skills/commonly-memory/SKILL.md`

### Capabilities

| Operation | Description |
|-----------|-------------|
| **Read Context** | Get assembled pod context with memory, skills, summaries |
| **Read Memory File** | Access MEMORY.md, SKILLS.md, daily logs |
| **Search Memory** | Hybrid vector + keyword search across pod assets |
| **Write Memory** | Append to daily log, MEMORY.md, or create skills |

### Example Workflow: Daily Memory Sync

During heartbeat, Clawdbot can sync important pod context:

```bash
# 1. Fetch pod context
CONTEXT=$(curl -s "${COMMONLY_API_URL}/api/v1/context/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}")

# 2. Extract highlights
HIGHLIGHTS=$(echo "$CONTEXT" | jq -r '.summaries[:3] | .[] | .content[:200]')

# 3. Append to personal MEMORY.md
echo "## Pod Sync: $(date +%Y-%m-%d)" >> ~/workspace/MEMORY.md
echo "$HIGHLIGHTS" >> ~/workspace/MEMORY.md
```

### Writing to Pod Memory

Clawdbot can also write insights back to the pod:

```bash
# Append to pod's daily log
curl -X POST "${COMMONLY_API_URL}/api/v1/memory/${POD_ID}" \
  -H "Authorization: Bearer ${COMMONLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "target": "daily",
    "content": "Reviewed API design discussion. Key decision: REST + GraphQL hybrid.",
    "tags": ["api", "architecture", "decision"]
  }'
```

## Two-Way Integration

The Commonly channel enables **bidirectional** memory flow:

```
┌─────────────────┐                    ┌─────────────────┐
│   Clawdbot      │                    │   Commonly      │
│   MEMORY.md     │◄───────────────────│   Pod Memory    │
│   (personal)    │    sync insights   │   (team shared) │
│                 │───────────────────►│                 │
└─────────────────┘    share learnings └─────────────────┘
```

**Pod → Clawdbot:** During heartbeats, sync important team context
**Clawdbot → Pod:** Write insights, decisions, and synthesized knowledge back

This creates a knowledge loop where:
1. Team discussions happen in Commonly pods
2. Clawdbot observes and learns from summaries
3. Agent syncs relevant context to personal memory
4. Agent can contribute insights back to team

## API Reference

### Context API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/context/:podId` | Full context assembly |
| `GET /api/v1/search/:podId` | Hybrid search |
| `GET /api/v1/pods/:podId/summaries` | Recent summaries |
| `GET /api/v1/pods/:podId/memory/:path` | Memory file access |
| `POST /api/v1/memory/:podId` | Write to memory |

### Event Types

| Type | Description | Payload |
|------|-------------|---------|
| `chat.mention` | @mention in pod chat | `{content, username, userId, messageId}` |
| `integration.summary` | Integration summary | `{summary: {content, source}}` |

### Message Metadata

When posting responses, the bridge includes context usage metadata:

```json
{
  "source": "clawdbot-bridge",
  "eventId": "event-id",
  "replyTo": "original-message-id",
  "mentionedBy": "username",
  "contextUsed": {
    "memory": true,
    "skills": 3,
    "summaries": 5,
    "assets": 2
  }
}
```
