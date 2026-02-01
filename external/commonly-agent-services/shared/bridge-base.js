/**
 * Bridge Base Class
 *
 * Common polling/messaging logic for agent bridges.
 * Extend this class to create new agent bridges.
 */

class BridgeBase {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.COMMONLY_BASE_URL || 'http://backend:5000';
    this.userToken = config.userToken || process.env.COMMONLY_USER_TOKEN;
    this.agentToken = config.agentToken || process.env.COMMONLY_AGENT_TOKEN;
    this.agentType = config.agentType || process.env.AGENT_TYPE || 'agent';
    this.instanceId = config.instanceId || process.env.AGENT_INSTANCE_ID || 'default';
    this.displayName = config.displayName || process.env.AGENT_DISPLAY_NAME || null;
    this.pollIntervalMs = config.pollIntervalMs
      || parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10)
      || 5000;

    this.processedEvents = new Set();
    this.isRunning = false;
    this.pollTimer = null;
  }

  /**
   * Get headers for runtime API calls
   */
  get runtimeHeaders() {
    if (!this.agentToken) return null;
    return {
      Authorization: `Bearer ${this.agentToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Get headers for bot API calls
   */
  get botHeaders() {
    if (!this.userToken) return null;
    return {
      Authorization: `Bearer ${this.userToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Get the active headers (prefer runtime token)
   */
  get headers() {
    return this.runtimeHeaders || this.botHeaders;
  }

  /**
   * Fetch pending events for this agent
   */
  async fetchEvents() {
    const url = new URL(`${this.baseUrl}/api/agents/runtime/events`);
    url.searchParams.append('agentName', this.agentType);
    url.searchParams.append('instanceId', this.instanceId);

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch events: ${res.status}`);
    }
    const data = await res.json();
    return data.events || [];
  }

  /**
   * Acknowledge an event
   */
  async ackEvent(eventId) {
    const res = await fetch(`${this.baseUrl}/api/agents/runtime/events/${eventId}/ack`, {
      method: 'POST',
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`Failed to ack event: ${res.status}`);
    }
  }

  /**
   * Post a message to a pod
   */
  async postMessage(podId, content, metadata = {}) {
    const res = await fetch(`${this.baseUrl}/api/agents/runtime/pods/${podId}/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        content,
        messageType: 'text',
        metadata: { ...metadata, agentType: this.agentType, instanceId: this.instanceId },
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to post message: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Post a comment to a thread
   */
  async postThreadComment(threadId, content) {
    const res = await fetch(`${this.baseUrl}/api/agents/runtime/threads/${threadId}/comments`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error(`Failed to post thread comment: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Get assembled context for a pod
   */
  async getContext(podId, task = null) {
    const url = new URL(`${this.baseUrl}/api/agents/runtime/pods/${podId}/context`);
    if (task) {
      url.searchParams.append('task', task);
    }
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      console.warn(`Failed to get context: ${res.status}`);
      return null;
    }
    return res.json();
  }

  /**
   * Get recent messages for a pod
   */
  async getMessages(podId, limit = 10) {
    const url = new URL(`${this.baseUrl}/api/agents/runtime/pods/${podId}/messages`);
    url.searchParams.append('limit', limit.toString());
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      console.warn(`Failed to get messages: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.messages || [];
  }

  /**
   * Report ensemble response (for AEP turn completion)
   */
  async reportEnsembleResponse(podId, ensembleId, content, messageId) {
    const res = await fetch(`${this.baseUrl}/api/pods/${podId}/ensemble/response`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        ensembleId,
        agentType: this.agentType,
        instanceId: this.instanceId,
        content,
        messageId,
      }),
    });
    if (!res.ok) {
      console.warn(`Failed to report ensemble response: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Check if an event was already processed
   */
  wasProcessed(eventId) {
    return this.processedEvents.has(eventId);
  }

  /**
   * Mark an event as processed
   */
  markProcessed(eventId) {
    this.processedEvents.add(eventId);
    // Keep set from growing indefinitely
    if (this.processedEvents.size > 1000) {
      const arr = Array.from(this.processedEvents);
      this.processedEvents = new Set(arr.slice(-500));
    }
  }

  /**
   * Handle a single event - override in subclass
   */
  async handleEvent(event) {
    throw new Error('handleEvent must be implemented by subclass');
  }

  /**
   * Poll for and process events
   */
  async poll() {
    try {
      const events = await this.fetchEvents();
      for (const event of events) {
        if (this.wasProcessed(event._id)) {
          await this.ackEvent(event._id);
          continue;
        }
        try {
          await this.handleEvent(event);
          this.markProcessed(event._id);
        } catch (err) {
          console.error(`Error handling event ${event._id}:`, err.message);
        }
        await this.ackEvent(event._id);
      }
    } catch (error) {
      console.error('Poll failed:', error.message);
    }
  }

  /**
   * Start the polling loop
   */
  start() {
    if (this.isRunning) {
      console.warn('Bridge is already running');
      return;
    }

    this.isRunning = true;
    console.log(`${this.getDisplayName()} Bridge starting...`);
    console.log(`  Agent Type: ${this.agentType} (instance: ${this.instanceId})`);
    console.log(`  Display Name: ${this.getDisplayName()}`);
    console.log(`  Commonly API: ${this.baseUrl}`);
    console.log(`  Poll interval: ${this.pollIntervalMs}ms`);

    // Initial connection test
    this.fetchEvents()
      .then((events) => {
        console.log(`${this.getDisplayName()} Bridge connected. ${events.length} pending events.`);
      })
      .catch((err) => {
        console.error(`${this.getDisplayName()} Bridge connection failed:`, err.message);
      });

    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop the polling loop
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    console.log(`${this.getDisplayName()} Bridge stopped.`);
  }

  /**
   * Get the display name for this agent
   */
  getDisplayName() {
    return this.displayName || this.agentType;
  }
}

module.exports = BridgeBase;
