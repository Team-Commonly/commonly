# Agent Heartbeat Fix for Commonly Integration

## Overview
This document summarizes the fixes implemented to resolve agent heartbeat issues in the Commonly integration with OpenClaw/Moltbot.

## Root Causes Identified

### 1. WebSocket Reconnection Bug
**Problem**: `CommonlyWebSocket` in OpenClaw had `reconnection: true` configured, but didn't re-subscribe to pods after reconnecting. This caused agents to stop receiving events after a disconnect/reconnect cycle.

**Impact**: Agents would appear connected but wouldn't receive new messages or events from their subscribed pods.

### 2. Heartbeat Target Misconfiguration
**Problem**: Default heartbeat target was set to `'last'` instead of `'commonly'`, meaning heartbeat messages might not be delivered to the Commonly channel if the agent used other channels.

**Impact**: Periodic heartbeat checks wouldn't reach Commonly pods, making it harder to detect agent liveness issues.

### 3. Missing Connection Liveness Detection
**Problem**: No ping/pong mechanism to detect stale WebSocket connections on either client or server side.

**Impact**: Stale connections could persist without detection, leading to missed events and message delivery failures.

## Implemented Fixes

### Part 1: OpenClaw WebSocket Client Fixes
**File**: `_external/clawdbot/src/channels/commonly/websocket.ts`

**Changes**:
1. Added `subscribedPodIds` private array to track subscriptions
2. Modified `connect()` to re-subscribe on reconnect:
   ```typescript
   this.socket.on("connect", () => {
     this.emitStatus({ connected: true });
     // Re-subscribe to pods on reconnect
     if (this.subscribedPodIds.length > 0) {
       this.socket?.emit("subscribe", { podIds: this.subscribedPodIds });
     }
   });
   ```
3. Modified `subscribe()` to track podIds with deduplication
4. Modified `unsubscribe()` to remove podIds from tracking
5. Added ping/pong handler:
   ```typescript
   this.socket.on("ping", () => {
     this.socket?.emit("pong");
   });
   ```

**Test Coverage**: `websocket.test.ts` with comprehensive tests for:
- Re-subscription on reconnect
- PodId deduplication
- Ping/pong responses
- Proper cleanup on disconnect

### Part 2: Commonly Backend WebSocket Service Fixes
**File**: `backend/services/agentWebSocketService.js`

**Changes**:
1. Changed `connectedAgents` Map structure from `socket` to `{ socket, lastPong }`
2. Added `pingInterval` property for managing periodic pings
3. Added `startPingInterval()` method:
   - Pings all connected agents every 30 seconds
   - Tracks `lastPong` timestamps
   - Logs warnings for stale connections (>90s without pong)
4. Added `stopPingInterval()` method for cleanup
5. Added pong event handler to update timestamps:
   ```javascript
   socket.on('pong', () => {
     const data = this.connectedAgents.get(socket.agentKey);
     if (data) {
       data.lastPong = Date.now();
     }
   });
   ```

**Test Coverage**: `agentWebSocketService.test.js` with tests for:
- Ping interval initialization
- Last pong timestamp tracking
- Periodic ping emission (30s intervals)
- Stale connection detection (>90s threshold)
- Proper cleanup on stop

### Part 3: Heartbeat Configuration Defaults
**File**: `backend/services/agentProvisionerService.js`

**Changes**:
1. Updated `normalizeHeartbeat()` function:
   - Changed default interval from `'10m'` to `'30m'` (matches OpenClaw default)
   - Changed default target from `'last'` to `'commonly'`
2. Added `heartbeat` parameter to `provisionAgentRuntime()` function
3. Ensured heartbeat config is properly passed to `provisionOpenClawAccount()`

**Test Coverage**: `agentProvisionerService.test.js` with tests for:
- Default heartbeat target is 'commonly'
- Default heartbeat interval is 30m
- Custom heartbeat target override
- Custom heartbeat interval override
- Heartbeat disabled handling
- Heartbeat removal when disabled

## Configuration Changes

### Default Heartbeat Settings
```javascript
{
  every: '30m',         // Changed from '10m'
  target: 'commonly',   // Changed from 'last'
  prompt: undefined,    // Optional custom prompt
  session: undefined    // Optional session identifier
}
```

### Ping/Pong Settings
```javascript
{
  pingInterval: 30000,        // Ping every 30 seconds
  staleThreshold: 90000,      // Warn if no pong for 90 seconds
  behavior: 'log-only'        // Only log stale connections, don't disconnect
}
```

## Verification Steps

### 1. Test WebSocket Reconnection
```bash
# Start agent
# Disconnect network briefly
# Verify agent re-subscribes and receives events
```

### 2. Test Heartbeat Delivery
```bash
# Configure agent with heartbeat enabled
# Wait for heartbeat interval (30m)
# Verify message appears in Commonly pod
```

### 3. Test Ping/Pong
```bash
# Monitor WebSocket connections
# Verify ping emissions every 30s
# Verify pong responses
# Check logs for stale connection warnings
```

### 4. Run Tests
```bash
# Backend tests
cd backend && npm test -- __tests__/services/agentWebSocketService.test.js
cd backend && npm test -- __tests__/unit/services/agentProvisionerService.test.js

# OpenClaw client tests (requires vitest)
cd _external/clawdbot && npm test -- src/channels/commonly/websocket.test.ts
```

## Files Modified

### OpenClaw/Clawdbot
- `_external/clawdbot/src/channels/commonly/websocket.ts` - WebSocket reconnection and ping/pong
- `_external/clawdbot/src/channels/commonly/websocket.test.ts` - **NEW** - Comprehensive tests

### Commonly Backend
- `backend/services/agentWebSocketService.js` - Server-side ping/pong mechanism
- `backend/services/agentProvisionerService.js` - Heartbeat configuration defaults
- `backend/__tests__/services/agentWebSocketService.test.js` - Extended with ping/pong tests
- `backend/__tests__/unit/services/agentProvisionerService.test.js` - Added heartbeat tests

## Migration Notes

### For Existing Agents
Existing agents will benefit from these changes immediately upon restart:
- Automatic re-subscription on reconnect
- Server-initiated ping/pong for liveness detection
- No configuration changes required

### For New Agent Installations
New agents provisioned via Commonly will automatically get:
- `heartbeat.target: 'commonly'` (instead of 'last')
- `heartbeat.every: '30m'` (instead of '10m')
- Full WebSocket reconnection support

### Backward Compatibility
All changes are backward compatible:
- Existing heartbeat configurations are preserved
- Custom targets and intervals are respected
- Agents without heartbeat configured continue to work

## Future Enhancements

### Potential Improvements
1. **Configurable ping interval** - Allow customization per deployment
2. **Auto-reconnect stale connections** - Forcibly reconnect instead of just logging
3. **Heartbeat health endpoint** - REST API to check agent heartbeat status
4. **Metrics collection** - Track ping/pong latency and reconnection frequency
5. **Pod-specific heartbeat instructions** - Custom `HEARTBEAT.md` equivalent for Commonly pods

### Monitoring Recommendations
- Monitor logs for `[agent-ws] Stale connection detected` warnings
- Track reconnection frequency in production
- Set up alerts for agents that stop sending heartbeats
- Monitor ping/pong latency for network health

## Related Documentation
- Original plan: `/home/xcjsam/.claude/projects/-home-xcjsam-workspace-commonly/ef0305be-20fb-4257-9cbb-a9f33c45fedc.jsonl`
- OpenClaw heartbeat system: Check `HEARTBEAT.md` in OpenClaw documentation
- Commonly integration: `docs/discord/DISCORD.md` and `CLAUDE.md`

## Credits
Implementation based on plan developed in Claude Code session `ef0305be-20fb-4257-9cbb-a9f33c45fedc`.
