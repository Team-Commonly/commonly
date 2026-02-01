# Plan: Fix Agent Identity Issues in Ensemble Discussions

## Problem Statement

When there are 3+ agents in an ensemble pod discussion:
- The third agent joins the discussion later (after it has started)
- The third agent's responses appear to come from the second agent
- Agent identity attribution becomes incorrect
- Turn tracking becomes misaligned

## Root Cause Analysis

### 1. Weak Agent Identity Verification
**Location**: `agentEnsembleService.js` lines 206-212

The system only **warns** when the wrong agent responds but continues processing:
```javascript
if (response.agentType !== turnState.currentAgent?.agentType) {
  console.warn(`Unexpected response from ${response.agentType}`);
  // CONTINUES PROCESSING ANYWAY!
}
```

### 2. Missing instanceId Validation
Only `agentType` is checked, `instanceId` is completely ignored. If you have multiple instances of the same agent type (e.g., two openclaw agents), they can respond for each other.

### 3. Turn Tracking Breaks When Participants Change Mid-Discussion
**Critical Issue**: When a third agent is added after discussion starts, the turn tracking uses modulo arithmetic that becomes misaligned.

Example with 2 agents initially:
- Turn 0: Agent A (0 % 2 = 0)
- Turn 1: Agent B (1 % 2 = 1)
- **Admin adds Agent C** (now 3 participants)
- Turn 2: Expected Agent A, but system calculates: 2 % 3 = 2 → Agent C!

### 4. No Authentication on Response Endpoint
The `/api/pods/:podId/ensemble/response` endpoint has no auth middleware, allowing any client to impersonate agents.

## Solution Design

### Fix 1: Strict Agent Verification
Verify BOTH agentType AND instanceId, reject mismatches entirely:

```javascript
// In agentEnsembleService.processAgentResponse()
if (response.agentType !== turnState.currentAgent?.agentType ||
    response.instanceId !== turnState.currentAgent?.instanceId) {
  throw new Error(`Response from wrong agent: got ${response.agentType}:${response.instanceId}, expected ${turnState.currentAgent.agentType}:${turnState.currentAgent.instanceId}`);
}
```

### Fix 2: Lock Participants During Active Discussion
Prevent participant changes while discussion is active:

```javascript
// In agentEnsembleService.updateConfig()
if (state.status === 'active' && config.participants) {
  throw new Error('Cannot modify participants during active discussion');
}
```

### Fix 3: Add Authentication to Response Endpoint
Add auth middleware and validate agent identity:

```javascript
// In routes/agentEnsemble.js
router.post('/:podId/ensemble/response', agentRuntimeAuth, async (req, res) => {
  // Verify the responding agent matches req.agentUser
  const { agentType, instanceId } = req.body;
  if (req.agentUser.botMetadata?.agentName !== agentType ||
      req.agentUser.botMetadata?.instanceId !== instanceId) {
    return res.status(403).json({ error: 'Agent identity mismatch' });
  }
  // ... rest of handler
});
```

### Fix 4: Add Response Tracking to Prevent Duplicates
Track messageId to prevent duplicate or out-of-order responses:

```javascript
// Add to AgentEnsembleState schema
lastProcessedMessageId: String,

// In processAgentResponse()
if (state.lastProcessedMessageId === response.messageId) {
  console.log('Duplicate response ignored');
  return state;
}
state.lastProcessedMessageId = response.messageId;
```

## Implementation Steps

### Step 1: Fix Agent Verification in processAgentResponse
**File**: `/backend/services/agentEnsembleService.js`

```javascript
static async processAgentResponse(ensembleId, response) {
  const state = await AgentEnsembleState.findById(ensembleId);
  if (!state) {
    throw new Error('Ensemble not found');
  }

  const { turnState } = state;

  // STRICT verification - reject wrong agent
  if (response.agentType !== turnState.currentAgent?.agentType ||
      response.instanceId !== (turnState.currentAgent?.instanceId || 'default')) {
    const expected = `${turnState.currentAgent?.agentType}:${turnState.currentAgent?.instanceId || 'default'}`;
    const received = `${response.agentType}:${response.instanceId || 'default'}`;
    throw new Error(`Wrong agent responded. Expected ${expected}, got ${received}`);
  }

  // Check for duplicate responses
  if (state.lastProcessedMessageId === response.messageId) {
    console.log(`[ensemble] Duplicate response from ${response.agentType}:${response.instanceId} ignored`);
    return state;
  }

  // Update checkpoint with VERIFIED agent identity
  state.checkpoint.recentHistory.push({
    agentType: turnState.currentAgent.agentType,  // Use verified identity
    instanceId: turnState.currentAgent.instanceId,
    content: response.content?.substring(0, 500),
    timestamp: new Date(),
  });

  state.lastProcessedMessageId = response.messageId;
  state.advanceTurn();
  await state.save();

  // ... rest of method
}
```

### Step 2: Lock Participants During Active Discussion
**File**: `/backend/services/agentEnsembleService.js`

```javascript
static async updateConfig(podId, config) {
  const state = await AgentEnsembleState.findOne({
    podId,
    status: { $in: ['active', 'pending', 'paused'] },
  });

  if (state) {
    // Prevent participant changes during active discussion
    if (state.status === 'active' && config.participants) {
      const currentCount = state.participants?.length || 0;
      const newCount = config.participants?.length || 0;

      // Check if participants are being modified
      if (currentCount !== newCount) {
        throw new Error('Cannot add or remove participants during active discussion. Please stop the discussion first.');
      }

      // Check if participant order/identity is changing
      const changed = config.participants.some((p, i) => {
        const current = state.participants[i];
        return p.agentType !== current.agentType ||
               p.instanceId !== current.instanceId;
      });

      if (changed) {
        throw new Error('Cannot modify participant identities during active discussion');
      }
    }

    // Apply updates
    if (config.topic) state.topic = config.topic;
    if (config.participants && state.status !== 'active') {
      state.participants = config.participants;
    }
    // ... rest of updates
  }
}
```

### Step 3: Add Authentication to Response Endpoint
**File**: `/backend/routes/agentEnsemble.js`

```javascript
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');

// Add auth middleware to response endpoint
router.post('/:podId/ensemble/response', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { ensembleId, agentType, instanceId, content, messageId } = req.body;

    // Verify agent identity matches authenticated agent
    const authAgentType = req.agentUser?.botMetadata?.agentName ||
                          req.agentInstallation?.agentName;
    const authInstanceId = req.agentUser?.botMetadata?.instanceId ||
                          req.agentInstallation?.instanceId || 'default';

    if (authAgentType !== agentType || authInstanceId !== instanceId) {
      return res.status(403).json({
        error: 'Agent identity mismatch',
        expected: `${authAgentType}:${authInstanceId}`,
        received: `${agentType}:${instanceId}`
      });
    }

    // Process the response
    const state = await AgentEnsembleService.processAgentResponse(ensembleId, {
      agentType,
      instanceId: instanceId || 'default',
      content,
      messageId,
    });

    res.json({
      success: true,
      nextAgent: state.turnState.currentAgent,
      turnNumber: state.turnState.turnNumber
    });
  } catch (error) {
    console.error('[ensemble] Response error:', error);
    res.status(400).json({ error: error.message });
  }
});
```

### Step 4: Update Frontend to Disable Changes During Active Discussion
**File**: `/frontend/src/components/agents/AgentEnsemblePanel.js`

```javascript
// Disable add participant button during active discussion
<Button
  variant="outlined"
  size="small"
  onClick={handleAddParticipant}
  sx={{ mb: 2 }}
  disabled={agentOptions.length === 0 || ensembleState?.status === 'active'}
>
  Add participant
</Button>

// Show warning if trying to save during active discussion
const handleSaveConfig = async () => {
  if (ensembleState?.status === 'active') {
    const participantsChanged = // ... check if participants differ
    if (participantsChanged) {
      alert('Cannot modify participants during active discussion. Please stop the discussion first.');
      return;
    }
  }
  // ... rest of save logic
};
```

### Step 5: Add Schema Field for Duplicate Detection
**File**: `/backend/models/AgentEnsembleState.js`

```javascript
// Add to schema
lastProcessedMessageId: {
  type: String,
  default: null,
},

// Add to turn state
turnState: {
  // ... existing fields ...
  lastResponseTime: {
    type: Date,
    default: null,
  },
  responseTimeouts: {
    type: Number,
    default: 0,
  },
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `/backend/services/agentEnsembleService.js` | Strict agent verification, participant locking |
| `/backend/routes/agentEnsemble.js` | Add auth middleware to response endpoint |
| `/backend/models/AgentEnsembleState.js` | Add lastProcessedMessageId field |
| `/frontend/src/components/agents/AgentEnsemblePanel.js` | Disable participant changes during active discussion |

## Verification

### Test Scenario 1: Agent Identity Verification
1. Start ensemble with Agent A and Agent B
2. Try to have Agent C respond when Agent A is expected
3. Verify: Response is rejected with error

### Test Scenario 2: Participant Locking
1. Start ensemble discussion with 2 agents
2. Try to add third agent via UI
3. Verify: Add button is disabled, or error shown if attempted via API

### Test Scenario 3: Correct Turn Attribution
1. Start ensemble with 3 agents
2. Let each agent respond in turn
3. Verify: Messages show correct agent names/avatars

### Test Scenario 4: Authentication
1. Try to post response without proper agent token
2. Verify: 401 Unauthorized error
3. Try to post response as wrong agent with valid token
4. Verify: 403 Forbidden error

## Summary

These fixes will ensure:
- **Strict agent identity verification** - only the expected agent can respond
- **Participant stability** - no adding/removing agents mid-discussion
- **Authenticated responses** - prevents impersonation
- **Correct attribution** - messages always show the right agent
- **No duplicate processing** - handles network retries gracefully

The third agent issue will be resolved because:
1. Participants can't be added mid-discussion (prevents turn misalignment)
2. Strict verification ensures only the correct agent responds
3. Authentication prevents identity spoofing
4. Turn tracking remains consistent throughout the discussion