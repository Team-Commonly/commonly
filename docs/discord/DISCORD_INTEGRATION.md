# Discord Integration Design

This document outlines the comprehensive Discord integration with the Commonly platform, enabling bidirectional communication, AI summarization, and seamless chat pod linking.

## Overview

The Discord integration provides multiple capabilities:
1. **AI Summary Fetching** - Fetch AI summaries from Commonly chat pods and display them in Discord
2. **Discord Channel Summarization** - Use webhook listeners to summarize Discord channel activity and send to Commonly
3. **Commonly Bot Integration** - A bot that aggregates messages from various apps and sends them to Commonly chat rooms
4. **Server/Channel Linking** - Link Discord servers/channels to specific Commonly chat pods

## Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Discord       │    │   Commonly       │    │   AI Services   │
│   Server        │◄──►│   Backend        │◄──►│   (Summarizer)  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Discord Bot   │    │   Chat Pods      │    │   Webhook       │
│   (Commonly)    │    │   (Frontend)     │    │   Listeners     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Core Features

### 1. AI Summary Fetching from Commonly Chat Pods

**Purpose**: Allow Discord users to fetch the existing hourly AI-generated summaries from the chat pod linked to their Discord server.

**Implementation**:
- Discord slash command: `/commonly-summary` (no parameters needed)
- Backend automatically identifies the linked chat pod via installation ID
- Fetches the most recent hourly summary from the existing summary system
- Bot responds with formatted summary in Discord

**User Flow**:
1. User types `/commonly-summary` in Discord
2. Backend identifies the chat pod linked to this Discord server via installation ID
3. Backend retrieves the most recent hourly summary from the existing summary system
4. Bot posts formatted summary to Discord channel

**Key Design Principle**: Discord bindings are **channel-scoped**. Multiple Commonly pods can be linked to the same Discord channel, and slash commands fan out to each linked pod.

**Integration with Existing System**:
- Uses the existing hourly summary generation that's already running for each pod
- No need to create new summarization logic
- Leverages existing summary storage and retrieval mechanisms
- Maintains consistency with the current summary format and timing

### 2. Discord Channel Summarization with Webhook Listeners

**Purpose**: Automatically summarize Discord channel activity and send to the linked Commonly chat pod.

**Implementation**:
- Webhook listener for each connected Discord channel
- Hourly summarization of channel activity
- AI processing of collected messages
- Automatic posting to the **linked** Commonly chat pod (no manual specification needed)

**User Flow**:
1. Admin enables webhook listener for a Discord channel
2. System automatically knows which chat pod to send summaries to (via installation ID)
3. System starts collecting messages from the channel
4. Every hour, AI summarizer processes collected messages
5. Summary is automatically posted to the linked chat pod's Commonly bot
6. Messages are cleared from temporary storage

### 3. Commonly Bot Integration

**Purpose**: A bot within Commonly chat pods that aggregates and presents information from the linked Discord server.

**Features**:
- Appears as a special user in chat pods
- Posts summaries, notifications, and aggregated content from the linked Discord server
- Manages webhook listeners and integration status
- Provides commands for managing Discord connections

**Bot Capabilities**:
- `/discord-status` - Show connected Discord channels for this server
- `/discord-summary <channel>` - Get recent summary from specific channel
- `/discord-enable <channel>` - Enable webhook listener for channel
- `/discord-disable <channel>` - Disable webhook listener for channel

### 4. Server/Channel Linking

**Purpose**: Establish channel-level bindings between Discord channels and Commonly chat pods.

**Implementation**:
- Handle Discord installation events when bot is added to a server
- Each Discord server installation automatically creates binding with a chat pod
- No OAuth2 flow needed - binding happens when app is installed
- Permission validation ensures proper access control

**Binding Process**:
1. User clicks installation link from a specific chat pod
2. Discord redirects to installation page with our app
3. User installs the app to their Discord server
4. Discord sends installation event to our webhook
5. Backend creates binding: `installationId` → `podId` from the installation context
6. All future interactions automatically use this binding

**Key Insight**: Since our Discord app is already created and working, we just need to:
- Handle the installation event when the app is added to a server
- Extract the `installationId` and server information from the event
- Create the binding with the chat pod that initiated the installation
- No OAuth2 flow required - Discord handles the installation process

## Database Schema

### Enhanced Integration Model
```javascript
{
  _id: ObjectId,
  installationId: String,              // Discord installation ID (unique identifier)
  podId: ObjectId,                     // Reference to Commonly chat pod (channel-scoped binding)
  type: String,                        // 'discord', 'telegram', 'slack'
  status: String,                      // 'connected', 'disconnected', 'error'
  config: {
    serverId: String,                  // Discord server ID
    serverName: String,                // Discord server name
    channelId: String,                 // Discord channel ID (for webhook)
    channelName: String,               // Discord channel name
    webhookUrl: String,                // Discord webhook URL
    botToken: String,                  // Encrypted bot token
    permissions: Array,                // Bot permissions
    webhookListenerEnabled: Boolean,   // Whether hourly summarization is active
    lastSummaryAt: Date,               // Last summary generation time
    messageBuffer: Array,              // Temporary message storage for summarization
    maxBufferSize: Number              // Maximum messages to store (default: 1000)
  },
  createdBy: ObjectId,                 // User who initiated the installation
  createdAt: Date,
  updatedAt: Date
}
```

**Key Design Points**:
- `installationId` is the primary identifier for each Discord server installation
- `podId` binds a specific chat pod to a Discord channel
- Multiple pods can share the same Discord channel (slash commands fan out per pod)
- The binding is established during OAuth2 installation and cannot be changed without re-installation

### Discord Message Buffer Model
```javascript
{
  _id: ObjectId,
  integrationId: ObjectId,            // Reference to Integration
  messageId: String,                  // Discord message ID
  authorId: String,                   // Discord user ID
  authorName: String,                 // Discord username
  content: String,                    // Message content
  timestamp: Date,                    // Message timestamp
  attachments: Array,                 // Message attachments
  reactions: Array,                   // Message reactions
  createdAt: Date                     // When stored in our system
}
```

### Summary History Model
```javascript
{
  _id: ObjectId,
  integrationId: ObjectId,            // Reference to Integration
  summaryType: String,                // 'hourly', 'daily', 'manual'
  content: String,                    // Generated summary text
  messageCount: Number,               // Number of messages summarized
  timeRange: {
    start: Date,
    end: Date
  },
  postedToDiscord: Boolean,           // Whether posted back to Discord
  postedToCommonly: Boolean,          // Whether posted to Commonly
  createdAt: Date
}
```

## API Endpoints

### Discord Bot Commands
- `POST /api/discord/commands/summary` - Handle `/commonly-summary` command (auto-identifies pod via installation ID)
- `POST /api/discord/commands/status` - Handle `/discord-status` command
- `POST /api/discord/commands/enable` - Handle `/discord-enable` command
- `POST /api/discord/commands/disable` - Handle `/discord-disable` command

### Integration Management
- `POST /api/webhooks/discord` - Handle Discord events (including installation events)
- `GET /api/integrations/discord/binding/:podId` - Get Discord binding for a specific chat pod
- `DELETE /api/integrations/discord/uninstall/:installationId` - Remove Discord integration
- `GET /api/integrations/discord/install-link/:podId` - Generate installation link for a chat pod

### Webhook and Summarization
- `POST /api/webhooks/discord` - Discord webhook endpoint (auto-routes to correct pod)
- `POST /api/integrations/:installationId/summarize` - Manual summary generation
- `GET /api/integrations/:installationId/summaries` - Get summary history
- `POST /api/integrations/:installationId/webhook/toggle` - Enable/disable webhook listener

### Commonly Bot Commands
- `POST /api/bot/commands/discord-status` - Handle bot commands in chat pods
- `POST /api/bot/commands/discord-summary` - Handle summary requests
- `POST /api/bot/commands/discord-enable` - Handle enable requests
- `POST /api/bot/commands/discord-disable` - Handle disable requests

**Key Design Principle**: Slash commands resolve the correct pod(s) via Discord `serverId` + `channelId`. If multiple pods share the same channel, commands fan out and return a combined response with one block per pod.

## UI/UX Design

### Chat Pod Sidebar Integration

**Purpose**: Provide a seamless way for users to initiate Discord integration from within each chat pod.

**Implementation**:
- Add "Integrations" section to chat pod sidebar
- Display Discord integration status and controls
- Generate installation links with pod context
- Track installation status and provide feedback

**UI Components**:

#### 1. Integrations Section in Sidebar
```
┌─────────────────────────┐
│ Integrations            │
├─────────────────────────┤
│ Discord                 │
│ [Not Connected]         │
│ [Connect Discord Bot]   │ ← Button
├─────────────────────────┤
│ Status: Disconnected    │
│ Server: None            │
│ Channel: None           │
└─────────────────────────┘
```

#### 2. Installation Flow
1. **Initial State**: "Not Connected" with "Connect Discord Bot" button
2. **Installation Link**: Button opens Discord installation URL with `state=pod_<podId>`
3. **Pending State**: Show "Installation in progress..." while waiting for webhook event
4. **Connected State**: Show server name, channel, and "Disconnect" option

#### 3. Connected State Display
```
┌─────────────────────────┐
│ Discord ✅ Connected    │
├─────────────────────────┤
│ Server: Gaming Community│
│ Channel: #general       │
│ Webhook: Enabled        │
├─────────────────────────┤
│ [Disconnect]            │
│ [Settings]              │
└─────────────────────────┘
```

### Installation Link Generation

**Backend Endpoint**: `GET /api/integrations/discord/install-link/:podId`

**Response**:
```javascript
{
  "installUrl": "https://discord.com/oauth2/authorize?client_id=1384815201089486911&permissions=...&state=pod_123",
  "podId": "123",
  "status": "ready"
}
```

**URL Parameters**:
- `client_id`: Our Discord app ID
- `permissions`: Required bot permissions
- `state`: Encoded pod ID for binding context
- `scope`: Bot installation scope

### Installation Status Tracking

**States**:
1. **Not Connected**: No integration exists
2. **Installing**: User clicked install, waiting for webhook event
3. **Connected**: Integration active and working
4. **Error**: Installation failed or connection lost

**Frontend State Management**:
```javascript
{
  discordIntegration: {
    status: 'not_connected' | 'installing' | 'connected' | 'error',
    serverName: string | null,
    channelName: string | null,
    installationId: string | null,
    lastUpdated: Date | null,
    errorMessage: string | null
  }
}
```

### Real-time Status Updates

**WebSocket Events**:
- `discord:installation_started` - User initiated installation
- `discord:installation_completed` - Webhook received installation event
- `discord:installation_failed` - Installation failed or timed out
- `discord:connection_lost` - Webhook connection lost

**Frontend Handling**:
```javascript
// Listen for Discord integration events
socket.on('discord:installation_completed', (data) => {
  updateDiscordStatus('connected', data);
  showSuccessNotification('Discord bot connected successfully!');
});

socket.on('discord:installation_failed', (error) => {
  updateDiscordStatus('error', { errorMessage: error.message });
  showErrorNotification('Discord installation failed. Please try again.');
});
```

### Error Handling and User Feedback

**Installation Timeout**:
- Show "Installation in progress..." for up to 5 minutes
- If no webhook event received, show "Installation timed out"
- Provide "Retry Installation" button

**Connection Issues**:
- Detect when webhook events stop coming
- Show "Connection lost" status
- Provide "Reconnect" option

**User Guidance**:
- Clear instructions on what to do during installation
- Help text explaining what the bot can do
- Troubleshooting tips for common issues

### Settings and Configuration

**Connected State Options**:
- **Webhook Listener**: Enable/disable hourly summarization
- **Channel Selection**: Choose which Discord channel to monitor
- **Summary Frequency**: Adjust how often summaries are generated
- **Notification Settings**: Configure what triggers notifications

**Settings Modal**:
```
┌─────────────────────────┐
│ Discord Settings        │
├─────────────────────────┤
│ Webhook Listener        │
│ [✓] Enabled             │
├─────────────────────────┤
│ Summary Frequency       │
│ [Hourly] [Daily]        │
├─────────────────────────┤
│ Notification Channel    │
│ #general                │
├─────────────────────────┤
│ [Save] [Cancel]         │
└─────────────────────────┘
```

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
1. **Database Schema Implementation**
   - Create new models for enhanced integration
   - Add message buffer and summary history models
   - Implement database migrations

2. **Discord Installation Event Handling**
   - Handle Discord installation events in webhook endpoint
   - Extract installation ID and server information
   - Create binding with chat pod that initiated installation
   - Store server and channel information

3. **Basic Webhook Endpoint Enhancement**
   - Extend existing webhook endpoint to handle installation events
   - Add message buffering for summarization
   - Implement basic message storage

4. **Frontend Foundation**
   - Add Integrations section to chat pod sidebar
   - Create Discord integration UI components
   - Implement installation link generation
   - Add basic status display

### Phase 2: AI Integration (Week 3-4)
1. **Existing Summary Integration**
   - Connect Discord commands to existing hourly summary system
   - Implement summary retrieval from existing storage
   - Add summary formatting for Discord display
   - No new AI summarization logic needed

2. **Discord Bot Commands**
   - Implement `/commonly-summary` command (fetches existing summary)
   - Add command validation and error handling
   - Create formatted response templates
   - Handle cases where no recent summary exists

3. **Commonly Bot Integration**
   - Create bot user system in chat pods
   - Implement bot command handling
   - Add bot message formatting

### Phase 3: Advanced Features (Week 5-6)
1. **Webhook Listener Management**
   - Add enable/disable functionality
   - Implement message buffer cleanup
   - Add configuration options

2. **Summary History and Analytics**
   - Track summary generation history
   - Add summary analytics and insights
   - Implement summary search functionality

3. **UI Integration**
   - Add Discord integration UI in chat pods
   - Create installation flow interface
   - Add status indicators and controls

### Phase 4: Polish and Optimization (Week 7-8)
1. **Performance Optimization**
   - Optimize message buffering
   - Implement efficient summarization
   - Add caching for frequently accessed data

2. **Error Handling and Monitoring**
   - Comprehensive error handling
   - Add monitoring and alerting
   - Implement retry mechanisms

3. **Documentation and Testing**
   - Complete API documentation
   - Add comprehensive tests
   - Create user guides

## Security Considerations

### OAuth2 and Bot Installation
- Validate OAuth2 state parameter
- Verify bot permissions before installation
- Encrypt stored bot tokens
- Implement token refresh handling

### Webhook Security
- Validate Discord webhook signatures
- Rate limit webhook endpoints
- Sanitize incoming message content
- Implement webhook URL rotation

### Data Privacy
- Minimize message storage duration
- Implement data retention policies
- Add user consent management
- Provide data export/deletion options

## Monitoring and Analytics

### Key Metrics
- Webhook delivery success rate
- Summary generation frequency
- Bot command usage statistics
- Integration connection health

### Alerting
- Webhook endpoint failures
- Bot token expiration warnings
- Summary generation failures
- High message buffer usage

## Future Enhancements

### Advanced Features
- **Real-time Summarization**: Generate summaries on-demand
- **Multi-channel Aggregation**: Summarize across multiple Discord channels
- **Custom Summary Formats**: Allow users to customize summary style
- **Integration Templates**: Pre-configured integration setups

### Platform Expansion
- **Slack Integration**: Similar functionality for Slack workspaces
- **Telegram Integration**: Support for Telegram channels
- **Email Integration**: Summarize email threads
- **RSS Feed Integration**: Summarize RSS feed content

### AI Enhancements
- **Sentiment Analysis**: Include sentiment in summaries
- **Topic Detection**: Group messages by topics
- **Key Point Extraction**: Highlight important points
- **Trend Analysis**: Identify trending topics over time

## Technical Requirements

### Dependencies
- Discord.js for bot functionality
- OAuth2 library for authentication
- Cron job scheduler for automated tasks
- Message queue system for async processing

### Infrastructure
- Webhook endpoint with SSL
- Database with good write performance
- Redis for message buffering
- Monitoring and logging infrastructure

### Rate Limits
- Discord API: 50 requests per second
- Webhook endpoints: 100 requests per minute
- Summary generation: 10 per hour per integration
- Bot commands: 5 per minute per user

This comprehensive design provides a solid foundation for building a robust Discord integration that enhances the Commonly platform with powerful AI-driven summarization capabilities.
