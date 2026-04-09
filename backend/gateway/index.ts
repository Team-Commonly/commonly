/**
 * Commonly Gateway
 *
 * WebSocket control plane for real-time communication between:
 * - Frontend clients (browsers)
 * - AI Agents (MCP connections)
 * - Integration bridges (Discord, Slack, etc.)
 *
 * The Gateway is the single source of truth for:
 * - Session state
 * - Event broadcasting
 * - Agent routing
 * - Client authentication
 */

// eslint-disable-next-line import/no-extraneous-dependencies
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { EventEmitter } = require('events');

// Event types
const EventTypes = {
  // Connection events
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  AUTHENTICATE: 'authenticate',
  AUTHENTICATED: 'authenticated',
  ERROR: 'error',

  // Chat events
  MESSAGE_CREATED: 'message.created',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_UPDATED: 'message.updated',

  // Pod events
  POD_JOINED: 'pod.joined',
  POD_LEFT: 'pod.left',
  MEMBER_JOINED: 'member.joined',
  MEMBER_LEFT: 'member.left',

  // Agent events
  AGENT_CONNECTED: 'agent.connected',
  AGENT_DISCONNECTED: 'agent.disconnected',
  AGENT_TYPING: 'agent.typing',
  AGENT_RESPONSE: 'agent.response',

  // Context events
  SUMMARY_CREATED: 'summary.created',
  SKILL_CREATED: 'skill.created',
  SKILL_UPDATED: 'skill.updated',
  MEMORY_UPDATED: 'memory.updated',

  // Federation events
  LINK_CREATED: 'link.created',
  LINK_APPROVED: 'link.approved',
  LINK_REVOKED: 'link.revoked',

  // Subscription
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
};

// Client types
const ClientTypes = {
  BROWSER: 'browser',
  AGENT: 'agent',
  INTEGRATION: 'integration',
  ADMIN: 'admin',
};

/**
 * Gateway Server
 */
class Gateway extends EventEmitter {
  constructor(options = {}) {
    super();

    this.port = options.port || parseInt(process.env.GATEWAY_PORT, 10) || 5001;
    this.host = options.host || process.env.GATEWAY_BIND || '127.0.0.1';
    this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET;

    this.wss = null;
    this.clients = new Map(); // clientId -> { ws, user, type, subscriptions }
    this.podSubscriptions = new Map(); // podId -> Set<clientId>
    this.agentConnections = new Map(); // agentId -> clientId

    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      messagesSent: 0,
      messagesReceived: 0,
    };
  }

  /**
   * Start the Gateway server
   */
  start() {
    this.wss = new WebSocket.Server({
      port: this.port,
      host: this.host,
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.wss.on('error', (error) => this.handleError(error));

    console.log(`Gateway listening on ws://${this.host}:${this.port}`);

    // Heartbeat to detect stale connections
    this.heartbeatInterval = setInterval(() => this.checkHeartbeats(), 30000);

    return this;
  }

  /**
   * Stop the Gateway server
   */
  stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.wss) {
      this.wss.close();
    }
  }

  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws, req) {
    const clientId = this.generateClientId();

    // Initialize client state
    this.clients.set(clientId, {
      ws,
      id: clientId,
      user: null,
      type: ClientTypes.BROWSER,
      subscriptions: new Set(),
      isAlive: true,
      connectedAt: new Date(),
    });

    this.stats.totalConnections += 1;
    this.stats.activeConnections += 1;

    // Setup message handler
    ws.on('message', (data) => this.handleMessage(clientId, data));
    ws.on('close', () => this.handleDisconnect(clientId));
    ws.on('pong', () => this.handlePong(clientId));
    ws.on('error', (error) => console.error(`Client ${clientId} error:`, error));

    // Send welcome message
    this.sendToClient(clientId, {
      type: EventTypes.CONNECT,
      payload: {
        clientId,
        message: 'Connected to Commonly Gateway',
        requiresAuth: true,
      },
    });

    this.emit(EventTypes.CONNECT, { clientId });
  }

  /**
   * Handle incoming message
   */
  handleMessage(clientId, data) {
    this.stats.messagesReceived += 1;

    try {
      const message = JSON.parse(data.toString());
      const { type, payload } = message;
      const client = this.clients.get(clientId);

      if (!client) return;

      // Handle authentication
      if (type === EventTypes.AUTHENTICATE) {
        this.handleAuthenticate(clientId, payload);
        return;
      }

      // All other messages require authentication
      if (!client.user) {
        this.sendToClient(clientId, {
          type: EventTypes.ERROR,
          payload: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      // Route message by type
      switch (type) {
        case EventTypes.SUBSCRIBE:
          this.handleSubscribe(clientId, payload);
          break;

        case EventTypes.UNSUBSCRIBE:
          this.handleUnsubscribe(clientId, payload);
          break;

        case EventTypes.MESSAGE_CREATED:
          this.handleBroadcastToPod(clientId, payload.podId, message);
          break;

        default:
          // Emit for custom handlers
          this.emit(type, { clientId, client, payload });
      }
    } catch (error) {
      console.error(`Error handling message from ${clientId}:`, error);
      this.sendToClient(clientId, {
        type: EventTypes.ERROR,
        payload: { code: 'INVALID_MESSAGE', message: error.message },
      });
    }
  }

  /**
   * Handle authentication
   */
  handleAuthenticate(clientId, payload) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { token, clientType = ClientTypes.BROWSER } = payload;

    try {
      // Verify JWT
      const decoded = jwt.verify(token, this.jwtSecret);

      // Update client state
      client.user = {
        id: decoded.userId || decoded.id,
        username: decoded.username,
      };
      client.type = clientType;

      // Track agent connections
      if (clientType === ClientTypes.AGENT && payload.agentId) {
        this.agentConnections.set(payload.agentId, clientId);
        client.agentId = payload.agentId;
      }

      this.sendToClient(clientId, {
        type: EventTypes.AUTHENTICATED,
        payload: {
          user: client.user,
          clientType: client.type,
        },
      });

      this.emit(EventTypes.AUTHENTICATED, { clientId, user: client.user, clientType });
    } catch (error) {
      this.sendToClient(clientId, {
        type: EventTypes.ERROR,
        payload: { code: 'AUTH_FAILED', message: 'Invalid token' },
      });
    }
  }

  /**
   * Handle subscription to pod events
   */
  handleSubscribe(clientId, payload) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { podId, events = [] } = payload;

    // Add to pod subscriptions
    if (!this.podSubscriptions.has(podId)) {
      this.podSubscriptions.set(podId, new Set());
    }
    this.podSubscriptions.get(podId).add(clientId);

    // Track on client
    client.subscriptions.add(podId);

    this.sendToClient(clientId, {
      type: 'subscribed',
      payload: { podId, events },
    });
  }

  /**
   * Handle unsubscription
   */
  handleUnsubscribe(clientId, payload) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { podId } = payload;

    // Remove from pod subscriptions
    const subscribers = this.podSubscriptions.get(podId);
    if (subscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.podSubscriptions.delete(podId);
      }
    }

    // Remove from client
    client.subscriptions.delete(podId);

    this.sendToClient(clientId, {
      type: 'unsubscribed',
      payload: { podId },
    });
  }

  /**
   * Handle disconnect
   */
  handleDisconnect(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Clean up subscriptions
    client.subscriptions.forEach((podId) => {
      const subscribers = this.podSubscriptions.get(podId);
      if (subscribers) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          this.podSubscriptions.delete(podId);
        }
      }
    });

    // Clean up agent connection
    if (client.agentId) {
      this.agentConnections.delete(client.agentId);
      this.emit(EventTypes.AGENT_DISCONNECTED, { agentId: client.agentId });
    }

    this.clients.delete(clientId);
    this.stats.activeConnections -= 1;

    this.emit(EventTypes.DISCONNECT, { clientId, user: client.user });
  }

  /**
   * Handle pong (heartbeat response)
   */
  handlePong(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.isAlive = true;
    }
  }

  /**
   * Check heartbeats and disconnect stale clients
   */
  checkHeartbeats() {
    this.clients.forEach((client, clientId) => {
      if (!client.isAlive) {
        console.log(`Terminating stale connection: ${clientId}`);
        client.ws.terminate();
        this.handleDisconnect(clientId);
      } else {
        client.isAlive = false;
        client.ws.ping();
      }
    });
  }

  /**
   * Send message to a specific client
   */
  sendToClient(clientId, message) {
    const client = this.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
      this.stats.messagesSent += 1;
    }
  }

  /**
   * Broadcast message to all subscribers of a pod
   */
  broadcastToPod(podId, message, excludeClientId = null) {
    const subscribers = this.podSubscriptions.get(podId);
    if (!subscribers) return;

    subscribers.forEach((clientId) => {
      if (clientId !== excludeClientId) {
        this.sendToClient(clientId, message);
      }
    });
  }

  /**
   * Send message to a specific agent
   */
  sendToAgent(agentId, message) {
    const clientId = this.agentConnections.get(agentId);
    if (clientId) {
      this.sendToClient(clientId, message);
    }
  }

  /**
   * Handle broadcast to pod (from a client)
   */
  handleBroadcastToPod(clientId, podId, message) {
    const client = this.clients.get(clientId);
    if (!client || !client.subscriptions.has(podId)) {
      this.sendToClient(clientId, {
        type: EventTypes.ERROR,
        payload: { code: 'NOT_SUBSCRIBED', message: 'Not subscribed to this pod' },
      });
      return;
    }

    // Add sender info
    message.payload.sender = {
      id: client.user.id,
      username: client.user.username,
      type: client.type,
      clientId,
    };

    this.broadcastToPod(podId, message, clientId);
  }

  /**
   * Handle server error
   */
  handleError(error) {
    console.error('Gateway error:', error);
    this.emit('error', error);
  }

  /**
   * Generate unique client ID
   */
  // eslint-disable-next-line class-methods-use-this
  generateClientId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get gateway statistics
   */
  getStats() {
    return {
      ...this.stats,
      clientsByType: this.getClientsByType(),
      podSubscriptionCount: this.podSubscriptions.size,
      agentConnectionCount: this.agentConnections.size,
    };
  }

  /**
   * Get client count by type
   */
  getClientsByType() {
    const counts = {};
    this.clients.forEach((client) => {
      counts[client.type] = (counts[client.type] || 0) + 1;
    });
    return counts;
  }
}

// Export singleton instance
let gateway = null;

const getGateway = () => {
  if (!gateway) {
    gateway = new Gateway();
  }
  return gateway;
};

const startGateway = (options) => {
  const gw = getGateway();
  gw.start(options);
  return gw;
};

module.exports = {
  Gateway,
  EventTypes,
  ClientTypes,
  getGateway,
  startGateway,
};
