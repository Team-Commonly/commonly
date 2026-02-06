# Agent Access to Integration Bot Tokens

**Created**: February 5, 2026
**Status**: 📋 Planning
**Purpose**: Enable agents to access Discord/GroupMe bot tokens for message fetching and summarization

---

## Overview

OpenClaw agents can already fetch messages from Discord/GroupMe channels using configured bot tokens. Currently, these tokens are stored in the Integration model (`config.botToken`), but there's no UI for users to configure them specifically for agent access. This plan enables:

1. **UI for Bot Token Configuration**: Users can configure Discord/GroupMe bot tokens in integration settings
2. **Agent Token Access**: When an agent is installed to a pod, it can access the integration's bot token
3. **Deprecate Standalone Summarizer**: Agents handle summarization directly, eliminating the need for a separate summarizer service

---

## Current Architecture

### Integration Model (Already Implemented)
Located in `backend/models/Integration.js`:

```javascript
{
  podId: ObjectId,
  type: 'discord' | 'telegram' | 'slack' | 'groupme' | ...,
  status: 'connected' | 'disconnected' | 'error' | 'pending',
  config: {
    // Discord/GroupMe specific
    serverId: String,
    serverName: String,
    channelId: String,
    channelName: String,
    webhookUrl: String,
    botToken: String,  // ✅ ALREADY EXISTS

    // GroupMe specific
    groupId: String,
    botId: String,
    accessToken: String,

    // ... other platform configs
  }
}
```

### AgentInstallation Model
Located in `backend/models/AgentRegistry.js`:

```javascript
{
  agentName: String,
  podId: ObjectId,
  instanceId: String,
  config: Map,
  scopes: [String],
  status: 'active' | 'paused' | 'uninstalled' | 'error',
  runtimeTokens: [{ tokenHash, label, createdAt, lastUsedAt }]
}
```

### OpenClaw Architecture
- OpenClaw agents already support fetching messages from Discord/GroupMe channels
- Agents authenticate using `cm_agent_*` runtime tokens
- Configuration happens in OpenClaw's channel config files

---

## Problem Statement

1. **No UI for Bot Token Config**: Users must manually configure bot tokens via environment variables or database edits
2. **Token Access Unclear**: No clear mechanism for agents to access integration tokens when installed
3. **Redundant Summarization**: Both standalone Summarizer and agents can summarize, causing confusion
4. **Missing Agent Permissions**: No scopes defined for integration token access

---

## Proposed Solution

### Phase 1: UI for Integration Bot Token Configuration

#### 1.1 Update Frontend Integration UI

**File**: `frontend/src/components/DiscordIntegration.js`

Add bot token configuration section (similar to webhook configuration):

```jsx
<TextField
  label="Bot Token (Optional)"
  placeholder="MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKfs"
  value={botToken}
  onChange={(e) => setBotToken(e.target.value)}
  fullWidth
  type="password"
  helperText="Enable agents to fetch messages from this Discord channel"
/>
```

**New Props**:
- `botToken` - State variable for bot token input
- `enableAgentAccess` - Toggle to enable/disable agent access

**Save Logic**:
```javascript
const handleSave = async () => {
  const response = await axios.post('/api/integrations', {
    podId,
    type: 'discord',
    config: {
      ...existingConfig,
      botToken: botToken || undefined,
      agentAccessEnabled: enableAgentAccess
    }
  });
};
```

#### 1.2 Create GroupMe Integration UI Component

**File**: `frontend/src/components/GroupMeIntegration.js` (NEW)

Similar to DiscordIntegration, but for GroupMe:

```jsx
const GroupMeIntegration = ({ podId, viewOnly = false }) => {
  const [groupId, setGroupId] = useState('');
  const [botId, setBotId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [enableAgentAccess, setEnableAgentAccess] = useState(false);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6">GroupMe Integration</Typography>

        <TextField
          label="Group ID"
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          fullWidth
        />

        <TextField
          label="Bot ID"
          value={botId}
          onChange={(e) => setBotId(e.target.value)}
          fullWidth
        />

        <TextField
          label="Access Token"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          type="password"
          fullWidth
          helperText="Enable agents to fetch messages from this GroupMe group"
        />

        <FormControlLabel
          control={
            <Switch
              checked={enableAgentAccess}
              onChange={(e) => setEnableAgentAccess(e.target.checked)}
            />
          }
          label="Allow agents to access messages"
        />
      </CardContent>
    </Card>
  );
};
```

#### 1.3 Backend Route Updates

**File**: `backend/routes/integrations.js`

Update POST /api/integrations to accept botToken:

```javascript
router.post('/', auth, async (req, res) => {
  try {
    const { podId, type, config } = req.body;

    // Validate bot token format if provided
    if (config.botToken) {
      validateBotToken(type, config.botToken);
    }

    const integration = await Integration.create({
      podId,
      type,
      config: {
        ...config,
        // Store botToken securely (encrypted in production)
        botToken: config.botToken,
        agentAccessEnabled: config.agentAccessEnabled || false
      },
      createdBy: req.user.userId
    });

    res.json(integration);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create integration' });
  }
});
```

---

### Phase 2: Agent Access to Integration Tokens

#### 2.1 Add Integration Access Scope

**File**: `backend/models/AgentRegistry.js`

Update AgentInstallation scopes to include integration access:

```javascript
const AgentInstallationSchema = new mongoose.Schema({
  // ... existing fields
  scopes: [String], // Add: 'integration:read', 'integration:messages:read'
});
```

#### 2.2 Create Integration Access Endpoint

**File**: `backend/routes/agentsRuntime.js`

Add endpoint for agents to access integration config:

```javascript
/**
 * GET /api/agents/runtime/pods/:podId/integrations
 * Get integration configs for a pod (agent runtime token auth)
 */
router.get('/pods/:podId/integrations', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const installation = req.agentInstallation;

    // Verify agent is installed in this pod
    if (installation.podId.toString() !== podId) {
      return res.status(403).json({ error: 'Agent not installed in this pod' });
    }

    // Verify agent has integration:read scope
    if (!installation.scopes.includes('integration:read')) {
      return res.status(403).json({ error: 'Missing integration:read scope' });
    }

    // Fetch integrations for this pod where agentAccessEnabled = true
    const integrations = await Integration.find({
      podId,
      'config.agentAccessEnabled': true,
      status: 'connected'
    }).select('type config.botToken config.channelId config.groupId config.accessToken');

    // Return sanitized integration data
    res.json({
      integrations: integrations.map(integration => ({
        id: integration._id,
        type: integration.type,
        channelId: integration.config.channelId,
        groupId: integration.config.groupId,
        // Bot tokens exposed ONLY to agents with proper scopes
        botToken: integration.config.botToken,
        accessToken: integration.config.accessToken
      }))
    });
  } catch (error) {
    console.error('Error fetching integrations for agent:', error);
    res.status(500).json({ error: 'Failed to fetch integrations' });
  }
});
```

#### 2.3 Create Message Fetching Endpoint

**File**: `backend/routes/agentsRuntime.js`

Add endpoint for agents to fetch messages from Discord/GroupMe:

```javascript
/**
 * GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages
 * Fetch messages from Discord/GroupMe channel (agent runtime token auth)
 */
router.get('/pods/:podId/integrations/:integrationId/messages', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId, integrationId } = req.params;
    const { limit = 100, before, after } = req.query;
    const installation = req.agentInstallation;

    // Verify agent has integration:messages:read scope
    if (!installation.scopes.includes('integration:messages:read')) {
      return res.status(403).json({ error: 'Missing integration:messages:read scope' });
    }

    // Fetch integration
    const integration = await Integration.findOne({
      _id: integrationId,
      podId,
      'config.agentAccessEnabled': true
    });

    if (!integration) {
      return res.status(404).json({ error: 'Integration not found or agent access disabled' });
    }

    // Fetch messages from Discord/GroupMe API
    let messages = [];

    if (integration.type === 'discord') {
      const DiscordService = require('../services/discordService');
      messages = await DiscordService.fetchMessages({
        channelId: integration.config.channelId,
        botToken: integration.config.botToken,
        limit,
        before,
        after
      });
    } else if (integration.type === 'groupme') {
      const GroupMeService = require('../services/groupmeService');
      messages = await GroupMeService.fetchMessages({
        groupId: integration.config.groupId,
        accessToken: integration.config.accessToken,
        limit,
        before_id: before,
        after_id: after
      });
    }

    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages for agent:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});
```

---

### Phase 3: Update Agent Installation Flow

#### 3.1 Add Integration Scopes to Installation

**File**: `backend/routes/registry.js`

Update agent installation to include integration scopes:

```javascript
router.post('/agents/:agentName/install', auth, async (req, res) => {
  try {
    const { agentName } = req.params;
    const { podId, config, instanceId = 'default' } = req.body;

    // Get agent registry entry
    const agent = await AgentRegistry.getByName(agentName);

    // Determine scopes based on agent requirements
    const scopes = [
      'pod:read',
      'pod:messages:write',
      'integration:read', // NEW: Access to integration configs
      'integration:messages:read' // NEW: Fetch messages from Discord/GroupMe
    ];

    // Install agent
    const installation = await AgentInstallation.install(agentName, podId, {
      version: agent.latestVersion,
      config,
      scopes,
      installedBy: req.user.userId,
      instanceId
    });

    res.json(installation);
  } catch (error) {
    res.status(500).json({ error: 'Failed to install agent' });
  }
});
```

---

### Phase 4: OpenClaw Integration

#### 4.1 Update Heartbeat Event Payload

**File**: `backend/services/agentEventService.js`

Include integration configs in heartbeat events:

```javascript
static async createHeartbeat({ agentName, instanceId, podId, triggerReason = 'scheduled' }) {
  const installation = await AgentInstallation.findOne({
    agentName: agentName.toLowerCase(),
    podId,
    instanceId,
    status: 'active'
  });

  if (!installation || !installation.scopes.includes('integration:read')) {
    return null;
  }

  // Fetch integrations with agent access enabled
  const integrations = await Integration.find({
    podId,
    'config.agentAccessEnabled': true,
    status: 'connected'
  }).select('type config.channelId config.groupId');

  return this.create({
    agentName,
    instanceId,
    podId,
    eventType: 'heartbeat',
    payload: {
      triggerReason,
      timestamp: new Date(),
      availableIntegrations: integrations.map(int => ({
        id: int._id,
        type: int.type,
        channelId: int.config.channelId,
        groupId: int.config.groupId
      }))
    }
  });
}
```

#### 4.2 Document OpenClaw Usage

**File**: `.codex/skills/integration-summarizer/SKILL.md` (NEW)

```markdown
# Integration Summarizer Skill

**Skill ID**: `integration-summarizer`
**Purpose**: Fetch and summarize messages from Discord/GroupMe integrations
**Runtime**: OpenClaw agents with `integration:read` and `integration:messages:read` scopes

## Overview

This skill enables agents to fetch messages from Discord and GroupMe channels that are integrated with Commonly pods. Agents can summarize chat activity and post insights to the pod.

## Prerequisites

- Agent must be installed to a pod with `integration:read` and `integration:messages:read` scopes
- Pod must have a Discord or GroupMe integration with `agentAccessEnabled: true`
- Integration must have a valid bot token configured

## API Endpoints

### 1. List Available Integrations

**Endpoint**: `GET /api/agents/runtime/pods/:podId/integrations`
**Auth**: Agent runtime token (`cm_agent_*`)

**Response**:
```json
{
  "integrations": [
    {
      "id": "673abc...",
      "type": "discord",
      "channelId": "1234567890",
      "botToken": "MTk4NjIyNDgzND..."
    },
    {
      "type": "groupme",
      "groupId": "98765432",
      "accessToken": "abc123..."
    }
  ]
}
```

### 2. Fetch Messages from Integration

**Endpoint**: `GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages`
**Auth**: Agent runtime token (`cm_agent_*`)

**Query Params**:
- `limit` (optional, default 100, max 1000) - Number of messages to fetch
- `before` (optional) - Fetch messages before this message ID
- `after` (optional) - Fetch messages after this message ID

**Response**:
```json
{
  "messages": [
    {
      "id": "msg_123",
      "authorId": "user_456",
      "authorName": "JohnDoe",
      "content": "Hello world!",
      "timestamp": "2026-02-05T10:30:00Z",
      "attachments": [],
      "reactions": []
    }
  ]
}
```

## Usage Flow

### On Heartbeat Event

When an agent receives a heartbeat event:

1. **Check for integrations** in the heartbeat payload:
```javascript
if (event.payload.availableIntegrations?.length > 0) {
  // Integration summarization available
}
```

2. **Fetch integration list**:
```javascript
const response = await fetch(`${COMMONLY_API}/api/agents/runtime/pods/${podId}/integrations`, {
  headers: { 'Authorization': `Bearer ${runtimeToken}` }
});
const { integrations } = await response.json();
```

3. **Fetch recent messages** (last hour):
```javascript
for (const integration of integrations) {
  const messagesResponse = await fetch(
    `${COMMONLY_API}/api/agents/runtime/pods/${podId}/integrations/${integration.id}/messages?limit=100`,
    { headers: { 'Authorization': `Bearer ${runtimeToken}` } }
  );
  const { messages } = await messagesResponse.json();

  // Filter messages from last hour
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentMessages = messages.filter(msg =>
    new Date(msg.timestamp).getTime() > oneHourAgo
  );

  if (recentMessages.length > 0) {
    // Summarize and post to pod
    const summary = await summarizeMessages(recentMessages, integration.type);
    await postToPod(podId, summary, runtimeToken);
  }
}
```

4. **Summarize messages** using LLM:
```javascript
async function summarizeMessages(messages, platform) {
  const prompt = `Summarize the following ${platform} chat messages from the last hour:\n\n${
    messages.map(m => `${m.authorName}: ${m.content}`).join('\n')
  }\n\nProvide a 2-3 sentence summary highlighting the main topics discussed.`;

  // Use agent's LLM provider
  const summary = await generateText(prompt);
  return summary;
}
```

5. **Post summary to pod**:
```javascript
async function postToPod(podId, summary, runtimeToken) {
  await fetch(`${COMMONLY_API}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${runtimeToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      content: `📊 ${platform} Activity Summary (Last Hour)\n\n${summary}`,
      messageType: 'text'
    })
  });
}
```

## Example: OpenClaw Implementation

```javascript
// In OpenClaw agent heartbeat handler
async function handleHeartbeat(event, agentConfig) {
  const { podId, payload } = event;
  const { availableIntegrations } = payload;

  if (!availableIntegrations || availableIntegrations.length === 0) {
    console.log('No integrations available for summarization');
    return 'NO_REPLY';
  }

  // Fetch integration details
  const integrationsResponse = await commonlyApi.get(
    `/agents/runtime/pods/${podId}/integrations`,
    { headers: { Authorization: `Bearer ${agentConfig.runtimeToken}` } }
  );

  const { integrations } = integrationsResponse.data;

  // Process each integration
  for (const integration of integrations) {
    try {
      // Fetch messages from last hour
      const messagesResponse = await commonlyApi.get(
        `/agents/runtime/pods/${podId}/integrations/${integration.id}/messages?limit=100`,
        { headers: { Authorization: `Bearer ${agentConfig.runtimeToken}` } }
      );

      const { messages } = messagesResponse.data;

      // Filter to last hour
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const recentMessages = messages.filter(msg =>
        new Date(msg.timestamp).getTime() > oneHourAgo
      );

      if (recentMessages.length === 0) {
        console.log(`No recent messages in ${integration.type} integration`);
        continue;
      }

      // Generate summary using agent's LLM
      const summary = await agentConfig.llm.generateText({
        prompt: `Summarize the following ${integration.type} chat messages:\n\n${
          recentMessages.map(m => `${m.authorName}: ${m.content}`).join('\n')
        }\n\nProvide a brief, engaging summary.`,
        maxTokens: 150
      });

      // Post summary to pod
      await commonlyApi.post(
        `/agents/runtime/pods/${podId}/messages`,
        {
          content: `📊 **${integration.type.toUpperCase()} Summary** (${recentMessages.length} messages)\n\n${summary}`,
          messageType: 'text'
        },
        { headers: { Authorization: `Bearer ${agentConfig.runtimeToken}` } }
      );

    } catch (error) {
      console.error(`Error processing ${integration.type} integration:`, error);
    }
  }

  return 'NO_REPLY'; // Don't send additional message
}
```

## Security Considerations

- **Scope Verification**: Endpoints verify `integration:messages:read` scope before exposing bot tokens
- **Agent-Only Access**: Only agents with active installations can access integration endpoints
- **Pod Isolation**: Agents can only access integrations from pods they're installed in
- **Token Encryption**: Bot tokens should be encrypted at rest in production
- **Rate Limiting**: Apply rate limits to prevent API abuse

## Benefits Over Standalone Summarizer

1. **No Slash Commands Needed**: Agents automatically summarize on heartbeat
2. **Cross-Platform**: Agents can summarize Discord, GroupMe, X, Instagram in one place
3. **Contextual Summaries**: Agents understand pod context and can tailor summaries
4. **Unified Architecture**: One system instead of separate summarizer service
5. **Extensible**: Easy to add new platforms (Telegram, Slack, etc.)

---

## Migration from Standalone Summarizer

### Phase 1: Parallel Operation
- Keep existing Summarizer service running
- Enable agents with integration access
- Monitor agent summaries vs Summarizer summaries

### Phase 2: Transition
- Disable Summarizer slash commands in new integrations
- Encourage users to install agents for summarization
- Update documentation to promote agent-based summarization

### Phase 3: Deprecation
- Mark Summarizer as deprecated
- Remove Summarizer from new installations
- Archive Summarizer codebase

---

**Status**: Ready for implementation ✅
```

---

## Implementation Checklist

### Backend
- [x] Add `config.agentAccessEnabled` field to Integration model
- [x] Create `GET /api/agents/runtime/pods/:podId/integrations` endpoint
- [x] Create `GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages` endpoint
- [x] Add `integration:read` and `integration:messages:read` scope checks on runtime endpoints
- [x] Update agent installation flow to auto-grant integration scopes
- [x] Add integration info to heartbeat event payloads
- [x] Create DiscordService.fetchMessages() method
- [x] Create GroupMeService.fetchMessages() method (if not exists)

### Frontend
- [x] Update DiscordIntegration component with bot token field
- [x] Add "Enable Agent Access" toggle to integration UI (GroupMe setup in pod chat)
- [ ] Create GroupMeIntegration component
- [x] Add integration status indicators (agent access enabled/disabled)
- [x] Update integration list to show agent-accessible integrations

### Documentation
- [x] Create `.codex/skills/integration-summarizer/SKILL.md`
- [ ] Update `docs/agents/AGENT_AUTONOMY.md` with integration access info
- [ ] Add migration guide from Summarizer to agent-based summarization
- [x] Update `CLAUDE.md` with new integration flow

### Testing
- [x] Unit tests for integration access endpoints
- [ ] Integration tests for agent message fetching
- [ ] E2E test: Agent fetches Discord messages and posts summary
- [x] Security test: Verify scope enforcement

---

## Timeline

**Week 1**: Backend implementation (endpoints + scopes)
**Week 2**: Frontend UI (integration configuration)
**Week 3**: OpenClaw integration + documentation
**Week 4**: Testing + migration preparation

---

## Related Files

- `backend/models/Integration.js` - Integration model with bot tokens
- `backend/models/AgentRegistry.js` - AgentInstallation model with scopes
- `backend/routes/agentsRuntime.js` - Agent runtime endpoints
- `frontend/src/components/DiscordIntegration.js` - Discord UI
- `backend/services/discordService.js` - Discord API service
- `docs/DISCORD_INTEGRATION_ARCHITECTURE.md` - Discord architecture

---

**Last Updated**: February 5, 2026
**Status**: 📋 Ready for implementation
