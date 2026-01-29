/**
 * Moltbot Provider
 *
 * Integration provider that allows moltbot to use Commonly as a context hub.
 * This provider:
 * - Connects to moltbot's Gateway via WebSocket
 * - Provides context from Commonly pods
 * - Receives messages and events from moltbot
 * - Syncs agent activity to Commonly
 */

/* eslint-disable max-classes-per-file, no-plusplus, no-restricted-syntax, global-require, import/no-extraneous-dependencies */
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';

/**
 * Moltbot Provider Configuration
 */
const ProviderManifest = {
  name: 'moltbot',
  displayName: 'Moltbot',
  description: 'Personal AI assistant across all messaging platforms',
  version: '1.0.0',
  capabilities: [
    'personal-assistant',
    'multi-channel',
    'voice',
    'browser-control',
    'calendar',
    'email',
  ],
  connectionType: 'websocket',
  defaultScopes: ['context:read', 'context:write', 'memory:read', 'memory:write', 'search:read'],
  events: ['message.created', 'summary.created', 'skill.created', 'pod.member.joined'],
};

/**
 * Moltbot Gateway Connection
 */
class MoltbotConnection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY_URL;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 5000;
    this.sessionId = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
  }

  /**
   * Connect to moltbot Gateway
   */
  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.gatewayUrl);

        this.ws.on('open', () => {
          console.log('[moltbot] Connected to Gateway');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          console.log(`[moltbot] Disconnected: ${code} ${reason}`);
          this.connected = false;
          this.emit('disconnected', { code, reason });
          this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
          console.error('[moltbot] WebSocket error:', error.message);
          this.emit('error', error);
          if (!this.connected) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from Gateway
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[moltbot] Max reconnect attempts reached');
      this.emit('maxReconnectReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * 1.5 ** (this.reconnectAttempts - 1);
    console.log(`[moltbot] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((err) => {
        console.error('[moltbot] Reconnect failed:', err.message);
      });
    }, delay);
  }

  /**
   * Handle incoming message from Gateway
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      // Handle RPC response
      if (message.id && this.pendingRequests.has(message.id)) {
        const { resolve, reject } = this.pendingRequests.get(message.id);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          reject(new Error(message.error.message || 'RPC error'));
        } else {
          resolve(message.result);
        }
        return;
      }

      // Handle events
      this.emit('message', message);

      // Route specific event types
      if (message.type) {
        this.emit(message.type, message.payload || message);
      }
    } catch (error) {
      console.error('[moltbot] Failed to parse message:', error);
    }
  }

  /**
   * Send RPC request to Gateway
   */
  async rpc(method, params = {}) {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to Gateway');
    }

    const id = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('RPC timeout'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.ws.send(JSON.stringify(request));
    });
  }

  /**
   * Send event to Gateway
   */
  send(type, payload) {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to Gateway');
    }

    this.ws.send(
      JSON.stringify({
        type,
        payload,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Moltbot Provider for Commonly
 */
class MoltbotProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.connection = new MoltbotConnection(options);
    this.commonlyApiUrl = options.commonlyApiUrl || 'http://localhost:5000';
    this.apiToken = options.apiToken;
    this.defaultPodId = options.defaultPodId;
    this.contextCache = new Map();
    this.cacheTimeout = options.cacheTimeout || 60000; // 1 minute
  }

  /**
   * Initialize the provider
   */
  async initialize() {
    // Set up event handlers
    this.connection.on('connected', () => this.handleConnected());
    this.connection.on('disconnected', () => this.handleDisconnected());
    this.connection.on('message', (msg) => this.handleGatewayMessage(msg));

    // Connect to moltbot Gateway
    await this.connection.connect();

    // Register as a context provider
    await this.registerAsProvider();
  }

  /**
   * Register Commonly as a context provider with moltbot
   */
  async registerAsProvider() {
    try {
      await this.connection.rpc('provider.register', {
        name: 'commonly',
        displayName: 'Commonly Context Hub',
        capabilities: ['context', 'memory', 'search', 'skills'],
        tools: [
          {
            name: 'commonly_search',
            description: 'Search Commonly pod memory',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                podId: { type: 'string', description: 'Pod ID (optional)' },
              },
              required: ['query'],
            },
          },
          {
            name: 'commonly_context',
            description: 'Get structured context from a Commonly pod',
            inputSchema: {
              type: 'object',
              properties: {
                podId: { type: 'string', description: 'Pod ID' },
                task: { type: 'string', description: 'Task for context filtering' },
              },
              required: ['podId'],
            },
          },
          {
            name: 'commonly_write',
            description: 'Write to Commonly pod memory',
            inputSchema: {
              type: 'object',
              properties: {
                podId: { type: 'string', description: 'Pod ID' },
                content: { type: 'string', description: 'Content to write' },
                target: { type: 'string', enum: ['daily', 'memory', 'skill'] },
              },
              required: ['podId', 'content', 'target'],
            },
          },
        ],
      });
      console.log('[moltbot] Registered as context provider');
    } catch (error) {
      console.error('[moltbot] Failed to register provider:', error);
    }
  }

  /**
   * Handle connection established
   */
  handleConnected() {
    this.emit('ready');
  }

  /**
   * Handle disconnection
   */
  handleDisconnected() {
    this.emit('disconnected');
  }

  /**
   * Handle incoming message from moltbot Gateway
   */
  async handleGatewayMessage(message) {
    // Handle tool calls from moltbot
    if (message.type === 'tool.call') {
      await this.handleToolCall(message);
    }

    // Handle context requests
    if (message.type === 'context.request') {
      await this.handleContextRequest(message);
    }

    this.emit('message', message);
  }

  /**
   * Handle tool call from moltbot
   */
  async handleToolCall(message) {
    const { toolName, arguments: args, requestId } = message.payload || message;

    try {
      let result;
      switch (toolName) {
        case 'commonly_search':
          result = await this.search(args.podId || this.defaultPodId, args.query, args);
          break;

        case 'commonly_context':
          result = await this.getContext(args.podId || this.defaultPodId, args);
          break;

        case 'commonly_write':
          result = await this.write(args.podId || this.defaultPodId, args);
          break;

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      // Send response
      this.connection.send('tool.result', {
        requestId,
        result,
        success: true,
      });
    } catch (error) {
      this.connection.send('tool.result', {
        requestId,
        error: error.message,
        success: false,
      });
    }
  }

  /**
   * Handle context request from moltbot
   */
  async handleContextRequest(message) {
    const { podId, task, requestId } = message.payload || message;

    try {
      const context = await this.getContext(podId || this.defaultPodId, { task });

      this.connection.send('context.response', {
        requestId,
        context,
        success: true,
      });
    } catch (error) {
      this.connection.send('context.response', {
        requestId,
        error: error.message,
        success: false,
      });
    }
  }

  /**
   * Search Commonly pod memory
   */
  async search(podId, query, options = {}) {
    const axios = require('axios');
    const params = new URLSearchParams();
    params.set('q', query);
    if (options.limit) params.set('limit', options.limit);
    if (options.types) params.set('types', options.types.join(','));

    const response = await axios.get(`${this.commonlyApiUrl}/api/v1/search/${podId}?${params}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    return response.data;
  }

  /**
   * Get context from Commonly pod
   */
  async getContext(podId, options = {}) {
    // Check cache first
    const cacheKey = `${podId}:${options.task || 'default'}`;
    const cached = this.contextCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    const axios = require('axios');
    const params = new URLSearchParams();
    if (options.task) params.set('task', options.task);
    if (options.includeSkills !== undefined) params.set('includeSkills', options.includeSkills);
    if (options.includeMemory !== undefined) params.set('includeMemory', options.includeMemory);

    const response = await axios.get(`${this.commonlyApiUrl}/api/v1/context/${podId}?${params}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    // Cache the result
    this.contextCache.set(cacheKey, {
      data: response.data,
      timestamp: Date.now(),
    });

    return response.data;
  }

  /**
   * Write to Commonly pod memory
   */
  async write(podId, options) {
    const axios = require('axios');
    const response = await axios.post(
      `${this.commonlyApiUrl}/api/v1/memory/${podId}`,
      {
        target: options.target,
        content: options.content,
        tags: options.tags,
        source: {
          agent: 'moltbot',
          sessionId: this.connection.sessionId,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
      },
    );

    // Clear cache for this pod
    for (const key of this.contextCache.keys()) {
      if (key.startsWith(podId)) {
        this.contextCache.delete(key);
      }
    }

    return response.data;
  }

  /**
   * Push an event to moltbot
   */
  pushEvent(eventType, payload) {
    this.connection.send('commonly.event', {
      eventType,
      payload,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Shutdown the provider
   */
  shutdown() {
    this.connection.disconnect();
  }
}

// Singleton instance
let providerInstance = null;

/**
 * Get or create the moltbot provider instance
 */
const getMoltbotProvider = (options) => {
  if (!providerInstance) {
    providerInstance = new MoltbotProvider(options);
  }
  return providerInstance;
};

/**
 * Initialize the moltbot provider
 */
const initializeMoltbotProvider = async (options) => {
  const provider = getMoltbotProvider(options);
  await provider.initialize();
  return provider;
};

module.exports = {
  MoltbotProvider,
  MoltbotConnection,
  ProviderManifest,
  getMoltbotProvider,
  initializeMoltbotProvider,
};
