const jwt = require('jsonwebtoken');
const AgentEventService = require('./agentEventService');
const { hash } = require('../utils/secret');

/**
 * Agent WebSocket Service
 *
 * Provides real-time event push to agent bridges via WebSocket.
 * Replaces polling for native channels (like Clawdbot Commonly channel).
 */

class AgentWebSocketService {
  constructor() {
    this.io = null;
    this.agentNamespace = null;
    this.connectedAgents = new Map(); // agentKey -> socket
  }

  /**
   * Initialize the agent WebSocket namespace
   * @param {SocketIO.Server} io - Socket.io server instance
   */
  init(io) {
    this.io = io;
    this.agentNamespace = io.of('/agents');

    // Authentication middleware for agent connections
    this.agentNamespace.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) {
          return next(new Error('Authentication required'));
        }

        // Validate agent token (cm_agent_* format)
        const agentInfo = await this.validateAgentToken(token);
        if (!agentInfo) {
          return next(new Error('Invalid agent token'));
        }

        socket.agentName = agentInfo.agentName;
        socket.instanceId = agentInfo.instanceId || 'default';
        socket.agentKey = `${socket.agentName}:${socket.instanceId}`;
        socket.subscribedPods = new Set();

        return next();
      } catch (err) {
        return next(new Error(`Authentication failed: ${err.message}`));
      }
    });

    // Handle agent connections
    this.agentNamespace.on('connection', (socket) => {
      console.log(`[agent-ws] Agent connected: ${socket.agentKey}`);

      // Store connection
      this.connectedAgents.set(socket.agentKey, socket);

      // Join agent-specific room
      socket.join(`agent:${socket.agentKey}`);

      // Handle pod subscription
      socket.on('subscribe', ({ podIds }) => {
        if (!Array.isArray(podIds)) return;

        podIds.forEach((podId) => {
          socket.join(`pod:${podId}`);
          socket.subscribedPods.add(podId);
        });

        console.log(`[agent-ws] ${socket.agentKey} subscribed to ${podIds.length} pods`);
      });

      // Handle pod unsubscription
      socket.on('unsubscribe', ({ podIds }) => {
        if (!Array.isArray(podIds)) return;

        podIds.forEach((podId) => {
          socket.leave(`pod:${podId}`);
          socket.subscribedPods.delete(podId);
        });
      });

      // Handle acknowledgment
      socket.on('ack', async ({ eventId }) => {
        if (!eventId) return;

        try {
          await AgentEventService.acknowledge(eventId, socket.agentName, socket.instanceId);
          socket.emit('ack:success', { eventId });
        } catch (err) {
          socket.emit('ack:error', { eventId, error: err.message });
        }
      });

      // Handle disconnect
      socket.on('disconnect', (reason) => {
        console.log(`[agent-ws] Agent disconnected: ${socket.agentKey} (${reason})`);
        this.connectedAgents.delete(socket.agentKey);
      });

      // Send welcome message
      socket.emit('connected', {
        agentName: socket.agentName,
        instanceId: socket.instanceId,
        message: 'Connected to Commonly agent WebSocket',
      });
    });

    console.log('[agent-ws] Agent WebSocket namespace initialized on /agents');
  }

  /**
   * Validate an agent token
   * Supports both JWT tokens and cm_agent_* format tokens
   */
  async validateAgentToken(token) {
    // Handle cm_agent_* format tokens
    if (token.startsWith('cm_agent_')) {
      // Look up token in database
      try {
        const { AgentInstallation } = require('../models/AgentRegistry');
        const tokenHash = hash(token);
        const installation = await AgentInstallation.findOne({
          'runtimeTokens.tokenHash': tokenHash,
          status: 'active',
        });

        if (installation) {
          try {
            await AgentInstallation.updateOne(
              { _id: installation._id, 'runtimeTokens.tokenHash': tokenHash },
              { $set: { 'runtimeTokens.$.lastUsedAt': new Date() } },
            );
          } catch (err) {
            console.warn('Failed to update agent token usage:', err.message);
          }

          return {
            agentName: installation.agentName,
            instanceId: installation.instanceId || 'default',
            podId: installation.podId,
          };
        }
      } catch {
        // Continue to JWT validation
      }
    }

    // Handle JWT tokens
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.agentName) {
        return {
          agentName: decoded.agentName,
          instanceId: decoded.instanceId || 'default',
        };
      }
    } catch {
      // Token invalid
    }

    return null;
  }

  /**
   * Push an event to a connected agent
   * @param {Object} event - The event to push
   */
  pushEvent(event) {
    if (!this.agentNamespace) return false;

    const agentKey = `${event.agentName}:${event.instanceId || 'default'}`;

    // Push to agent-specific room
    this.agentNamespace.to(`agent:${agentKey}`).emit('event', event);

    // Also push to pod room for agents subscribed to that pod
    if (event.podId) {
      this.agentNamespace.to(`pod:${event.podId}`).emit('event', event);
    }

    return true;
  }

  /**
   * Check if an agent is connected
   */
  isAgentConnected(agentName, instanceId = 'default') {
    return this.connectedAgents.has(`${agentName}:${instanceId}`);
  }

  /**
   * Get count of connected agents
   */
  getConnectedCount() {
    return this.connectedAgents.size;
  }

  /**
   * Get list of connected agent keys
   */
  getConnectedAgents() {
    return Array.from(this.connectedAgents.keys());
  }

  /**
   * Broadcast to all connected agents
   */
  broadcast(eventName, data) {
    if (!this.agentNamespace) return;
    this.agentNamespace.emit(eventName, data);
  }
}

// Singleton instance
const agentWebSocketService = new AgentWebSocketService();

module.exports = agentWebSocketService;
