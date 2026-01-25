# Discord Integration Architecture

## Overview

Commonly's Discord integration provides bidirectional synchronization between Discord servers and Commonly pods. The system uses API-based polling for Discord message retrieval and webhook-based posting for sending messages to Discord.

## Architecture Design

### Core Philosophy
- **API Polling**: Fetch Discord messages via Discord API (no webhook listeners)
- **Unified Internal API**: Both manual and automatic sync use the same underlying methods
- **Quality Filtering**: Only meaningful human messages are processed
- **Scheduled Automation**: Hourly synchronization with predictable resource usage

### Key Components

#### 1. DiscordService (`backend/services/discordService.js`)
**Primary service handling Discord API interactions**

**Key Methods:**
- `syncRecentMessages(timeRangeHours = 1)` - **Unified sync method** used by both manual commands and automatic scheduler
- `fetchMessages(options)` - Direct Discord API message fetching with bot filtering
- `createDiscordSummary()` - AI-powered message summarization using Gemini
- `sendMessage()` - Send messages TO Discord via webhook

**Message Filtering Logic:**
```javascript
const filteredMessages = messages.filter(msg => {
  const msgTime = new Date(msg.timestamp);
  const isInTimeRange = msgTime >= timeAgo;
  const isHuman = !msg.author?.bot;           // Exclude bot messages
  const hasContent = msg.content && msg.content.trim().length > 0;
  
  return isInTimeRange && isHuman && hasContent;
});
```

#### 2. DiscordCommandService (`backend/services/discordCommandService.js`)
**Handles Discord slash commands**

**Commands:**
- `/discord-status` - Shows integration status and sync settings
- `/discord-enable` - Enables automatic hourly sync
- `/discord-disable` - Disables automatic hourly sync  
- `/discord-push` - Manual sync trigger (uses `syncRecentMessages(1)`)

#### 2b. DiscordMultiCommandService (`backend/services/discordMultiCommandService.js`)
**Fan-out handler for multi-pod channels**

- When multiple Commonly pods are linked to the same Discord channel, slash commands are executed per integration.
- Aggregates results into a single Discord response with one block per pod.
- Uses `DiscordService.initialize()` for `/discord-push` to ensure channel-specific state is loaded.

#### 3. SchedulerService (`backend/services/schedulerService.js`)
**Manages periodic tasks**

**Discord Integration:**
- **Step 1**: `syncAllDiscordIntegrations()` - Process all active Discord integrations
- Runs hourly via cron: `0 * * * *` (every hour at minute 0)
- Finds all integrations where `config.webhookListenerEnabled: true`
- Calls `syncRecentMessages(1)` for each integration

#### 4. CommonlyBotService (`backend/services/commonlyBotService.js`)
**Posts Discord summaries to Commonly pods**

- Creates @commonly-bot user posts in Commonly pods
- Formats Discord activity summaries with metadata
- Tracks posting history via DiscordSummaryHistory model

## Data Flow

### Automatic Hourly Sync
```
[Cron Schedule] 
    ↓
[SchedulerService.syncAllDiscordIntegrations()]
    ↓
[Find active Discord integrations]
    ↓
[For each integration: DiscordService.syncRecentMessages(1)]
    ↓
[Discord API: fetchMessages() with filtering]
    ↓
[AI Summarization via Gemini]
    ↓
[CommonlyBotService.postDiscordSummaryToPod()]
    ↓
[Save to DiscordSummaryHistory]
```

### Manual Sync (/discord-push)
```
[Discord Slash Command: /discord-push]
    ↓
[DiscordCommandService.handlePushCommand()]
    ↓
[DiscordService.syncRecentMessages(1)]
    ↓
[Same flow as automatic sync]
    ↓
[Return formatted response to Discord]
```

### Slash Commands with Multi-Pod Channels
```
[Discord Slash Command]
    ↓
[Route: /api/discord/interactions]
    ↓
[Find integrations by serverId + channelId]
    ↓
if 1 match:
  → [DiscordService.handleInteraction]
else if >1 match:
  → [DiscordMultiCommandService fan-out per integration]
    → [Aggregate response blocks]
```

## Configuration

### Integration Settings
```javascript
{
  type: 'discord',
  isActive: true,
  config: {
    serverId: 'Discord server/guild ID',
    serverName: 'Human-readable server name',
    channelId: 'Discord channel ID to monitor',
    channelName: 'Human-readable channel name',
    webhookListenerEnabled: true,  // Controls auto-sync (renamed from webhook listener)
    messageBuffer: [],             // Legacy, no longer used
    maxBufferSize: 1000           // Legacy, no longer used
  },
  podId: 'ObjectId of linked Commonly pod'
}
```

**Multi-pod channels**: multiple integrations can share the same `serverId` + `channelId` pair, each with a different `podId`. Slash command responses include one section per pod.

### Environment Variables
```bash
DISCORD_CLIENT_ID=your_discord_app_client_id
DISCORD_CLIENT_SECRET=your_discord_app_secret  
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_PUBLIC_KEY=your_discord_app_public_key
```

## Key Improvements Made

### 1. Eliminated Circular Dependencies
**Problem**: `DiscordCommandService` was trying to create new `DiscordService` instances, causing "DiscordService is not a constructor" errors.

**Solution**: Pass existing `DiscordService` instance to command handlers:
```javascript
// In discordService.js
case 'discord-push':
  return await this.commandService.handlePushCommand(this);  // Pass 'this'

// In discordCommandService.js  
async handlePushCommand(discordServiceInstance = null) {
  const syncResult = await discordServiceInstance.syncRecentMessages(1);
}
```

### 2. Unified API Architecture
**Before**: Separate logic in manual command vs automatic sync
**After**: Single `syncRecentMessages()` method used by both

**Benefits**:
- No code duplication
- Consistent filtering logic
- Easier maintenance and testing
- Same message quality for both manual and automatic sync

### 3. API Polling vs Webhook Listeners
**Before**: Complex webhook listener system with message buffering
**After**: Simple hourly API polling

**Benefits**:
- Reduced server load (predictable hourly requests vs unpredictable webhook traffic)
- Simpler architecture (no webhook endpoints to maintain)
- Better rate limit management
- No message loss due to webhook failures

### 4. Enhanced Message Quality
**Filtering Applied**:
- Bot messages excluded (`!msg.author?.bot`)
- Empty/whitespace-only messages excluded
- Only messages within specified time range
- Content validation to ensure meaningful messages

## Error Handling

### Common Issues & Solutions

1. **"Channel ID not found in integration config"**
   - Ensure `config.channelId` is properly set during integration setup

2. **"Discord sync not enabled for this integration"**  
   - User needs to run `/discord-enable` command first
   - Check `config.webhookListenerEnabled` is true

3. **"Failed to fetch Discord messages"**
   - Verify Discord bot token is valid
   - Check bot has proper permissions in channel
   - Ensure Discord API is accessible

## Future Enhancements

### Potential Improvements
1. **Configurable Sync Frequency**: Allow per-integration custom sync intervals
2. **Message Thread Support**: Handle Discord thread messages  
3. **Rich Embed Processing**: Better handling of Discord embeds and attachments
4. **Sentiment Analysis**: Enhanced message analysis beyond basic summarization
5. **User Mention Mapping**: Map Discord users to Commonly users where possible

### Monitoring & Analytics
- Track sync success rates per integration
- Monitor API rate limit usage
- Measure summary quality and user engagement
- Performance metrics for large Discord servers

## Testing

### Manual Testing
1. Set up Discord integration via frontend
2. Run `/discord-push` command in Discord
3. Verify summary appears in linked Commonly pod
4. Enable auto-sync with `/discord-enable`
5. Wait for next hourly sync and verify automatic posting

### Automated Testing
```bash
# Run Discord integration tests
cd backend && npm run test:discord

# Test specific Discord service methods
cd backend && npm test -- --grep "DiscordService"
```

## Deployment Notes

### Discord Application Setup
1. Create Discord application at https://discord.com/developers/applications
2. Configure OAuth2 redirect URIs for integration flow
3. Set up bot with required permissions
4. Deploy slash commands: `npm run discord:deploy`

### Required Permissions
- Read Messages
- Send Messages  
- Use Slash Commands
- Read Message History

### Production Considerations
- Monitor Discord API rate limits (50 requests per second)
- Set up proper error alerting for failed syncs
- Consider Redis caching for high-volume servers
- Implement graceful degradation for Discord API outages
