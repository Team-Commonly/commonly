/**
 * Clawd-bot Bridge - Commonly Channel Integration
 *
 * This service bridges Commonly pods with Clawd-bot AI, enabling:
 * - Direct @clawd-bot mentions in pod chat
 * - Full context assembly using Commonly's Bot API
 * - Context-aware responses with pod memory, skills, and summaries
 *
 * Authentication: Uses a bot user API token (cm_*) with scoped permissions
 * Required scopes: agent:events:read, agent:events:ack, agent:context:read,
 *                  agent:messages:read, agent:messages:write
 */

const baseUrl = process.env.COMMONLY_BASE_URL || 'http://backend:5000';
const token = process.env.COMMONLY_USER_TOKEN || process.env.COMMONLY_AGENT_TOKEN;
const gatewayUrl = process.env.CLAWDBOT_GATEWAY_URL || 'http://clawdbot-gateway:18789';
const gatewayToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
const agentId = process.env.CLAWDBOT_AGENT_ID || 'main';
const model = process.env.CLAWDBOT_MODEL || `moltbot:${agentId}`;
const agentName = process.env.CLAWDBOT_AGENT_NAME || 'clawd-bot';
const instanceId = process.env.CLAWDBOT_INSTANCE_ID || 'default';

if (!token) {
  console.error('COMMONLY_USER_TOKEN is required (API token for clawd-bot user).');
  process.exit(1);
}

if (!gatewayToken) {
  console.error('CLAWDBOT_GATEWAY_TOKEN is required.');
  process.exit(1);
}

const commonlyHeaders = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const clawdbotHeaders = {
  Authorization: `Bearer ${gatewayToken}`,
  'Content-Type': 'application/json',
  'x-moltbot-agent-id': agentId,
};

// ============================================================================
// Commonly Bot API Functions (/api/agents/runtime/bot/* endpoints)
// ============================================================================

/**
 * Fetch pending events for clawd-bot using bot user API
 * Uses /api/agents/runtime/bot/events with scoped token
 */
const fetchEvents = async () => {
  const url = new URL(`${baseUrl}/api/agents/runtime/bot/events`);
  url.searchParams.append('agentName', agentName);
  url.searchParams.append('instanceId', instanceId);

  const res = await fetch(url, { headers: commonlyHeaders });
  if (!res.ok) {
    throw new Error(`Failed to fetch events: ${res.status}`);
  }
  const data = await res.json();
  return data.events || [];
};

/**
 * Post message to pod using bot message API
 */
const postMessage = async (podId, content, metadata = {}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/bot/pods/${podId}/messages`, {
    method: 'POST',
    headers: commonlyHeaders,
    body: JSON.stringify({
      agentName,
      instanceId,
      content,
      messageType: 'text',
      metadata,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
  return res.json();
};

/**
 * Acknowledge event via bot API
 */
const ackEvent = async (eventId) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/bot/events/${eventId}/ack`, {
    method: 'POST',
    headers: commonlyHeaders,
    body: JSON.stringify({ agentName, instanceId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to ack event: ${res.status}`);
  }
};

/**
 * Get full assembled context from bot context API
 * Uses /api/agents/runtime/bot/pods/:podId/context
 */
const getAssembledContext = async (podId, task = null) => {
  const url = new URL(`${baseUrl}/api/agents/runtime/bot/pods/${podId}/context`);
  url.searchParams.append('agentName', agentName);
  url.searchParams.append('instanceId', instanceId);
  if (task) {
    url.searchParams.append('task', task);
  }

  const res = await fetch(url, { headers: commonlyHeaders });
  if (!res.ok) {
    console.warn(`Failed to get assembled context: ${res.status}`);
    return null;
  }
  return res.json();
};

/**
 * Get recent chat messages using bot messages API
 */
const getRecentMessages = async (podId, limit = 10) => {
  const url = new URL(`${baseUrl}/api/agents/runtime/bot/pods/${podId}/messages`);
  url.searchParams.append('agentName', agentName);
  url.searchParams.append('instanceId', instanceId);
  url.searchParams.append('limit', limit.toString());

  const res = await fetch(url, { headers: commonlyHeaders });
  if (!res.ok) {
    console.warn(`Failed to get recent messages: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.messages || [];
};

/**
 * Get recent summaries for the pod (still uses v1 API)
 */
const getRecentSummaries = async (podId, hours = 24) => {
  const res = await fetch(`${baseUrl}/api/v1/pods/${podId}/summaries?hours=${hours}`, {
    headers: commonlyHeaders,
  });
  if (!res.ok) {
    console.warn(`Failed to get summaries: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.summaries || [];
};

/**
 * Write to pod memory (MEMORY.md, daily log, or skill)
 */
const writeMemory = async (podId, { target, content, tags = [], source = {} }) => {
  const res = await fetch(`${baseUrl}/api/v1/memory/${podId}`, {
    method: 'POST',
    headers: commonlyHeaders,
    body: JSON.stringify({
      target,
      content,
      tags,
      source: { ...source, agent: agentName, instanceId },
    }),
  });
  if (!res.ok) {
    console.warn(`Failed to write memory: ${res.status}`);
    return null;
  }
  return res.json();
};

// ============================================================================
// Context Building
// ============================================================================

/**
 * Build a rich context prompt from Commonly's context assembly
 */
const buildContextPrompt = (context) => {
  if (!context) return '';

  const parts = [];

  // Pod info
  if (context.pod) {
    parts.push(`## Pod: ${context.pod.name}`);
    if (context.pod.description) {
      parts.push(context.pod.description);
    }
  }

  // Memory
  if (context.memory) {
    parts.push(`\n## Pod Memory\n${context.memory.substring(0, 1000)}`);
  }

  // Skills
  if (context.skills?.length > 0) {
    parts.push('\n## Available Skills');
    context.skills.slice(0, 3).forEach((skill) => {
      parts.push(`- **${skill.name}**: ${skill.description || 'No description'}`);
    });
  }

  // Recent summaries
  if (context.summaries?.length > 0) {
    parts.push('\n## Recent Activity');
    context.summaries.slice(0, 3).forEach((summary) => {
      parts.push(`- ${summary.content?.substring(0, 200) || 'Activity recorded'}`);
    });
  }

  // Relevant assets
  if (context.assets?.length > 0) {
    parts.push('\n## Relevant Context');
    context.assets.slice(0, 3).forEach((asset) => {
      parts.push(`- **${asset.title}**: ${asset.snippet || ''}`);
    });
  }

  return parts.join('\n');
};

/**
 * Build conversation history from recent messages
 */
const buildConversationHistory = (messages) => {
  if (!messages || messages.length === 0) return '';

  const formatted = messages
    .slice(-10)
    .map((msg) => `${msg.userId?.username || msg.username || 'Unknown'}: ${msg.content}`)
    .join('\n');

  return `\n## Recent Conversation\n${formatted}`;
};

// ============================================================================
// Clawd-bot AI Integration
// ============================================================================

/**
 * Call Clawd-bot AI with full context
 */
const callClawdbotWithContext = async (userMessage, contextPrompt, conversationHistory) => {
  const systemPrompt = `You are Clawd 🐾, an AI assistant integrated into a Commonly pod.

You have access to the pod's context, memory, skills, and recent activity.
Use this information to provide helpful, contextual responses.

${contextPrompt}
${conversationHistory}

Guidelines:
- Be friendly and conversational
- Reference pod context when relevant
- Keep responses concise but helpful
- If asked about skills or memory, use the context provided`;

  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: clawdbotHeaders,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    throw new Error(`Clawd-bot request failed: ${res.status}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!content) {
    throw new Error('Clawd-bot response missing content');
  }
  return String(content).trim();
};

/**
 * Simple call for integration summaries
 */
const callClawdbotSimple = async (summary) => {
  const prompt = `You are Clawd 🐾, a helpful assistant posting into a Commonly pod.

Summarize and respond to this integration update in 2-3 sentences, optionally with 1 action item if relevant.

Update:
${summary}`;

  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: clawdbotHeaders,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    throw new Error(`Clawd-bot request failed: ${res.status}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!content) {
    throw new Error('Clawd-bot response missing content');
  }
  return String(content).trim();
};

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle chat.mention events (direct @mentions)
 */
const handleMentionEvent = async (event) => {
  const { content, username, messageId } = event.payload || {};

  if (!content) {
    return ackEvent(event._id);
  }

  console.log(`Processing mention from @${username}: "${content.substring(0, 50)}..."`);

  try {
    // Fetch full context from Commonly's Bot Context API
    // The task parameter triggers relevant skill/asset matching
    const [context, messages] = await Promise.all([
      getAssembledContext(event.podId, content),
      getRecentMessages(event.podId, 15),
    ]);

    // Build context prompts
    const contextPrompt = buildContextPrompt(context);
    const conversationHistory = buildConversationHistory(messages);

    // Call Clawd-bot with full context
    const response = await callClawdbotWithContext(
      `@${username} asks: ${content}`,
      contextPrompt,
      conversationHistory,
    );

    // Post response to pod
    await postMessage(event.podId, response, {
      source: 'clawd-bot',
      eventId: event._id,
      replyTo: messageId,
      mentionedBy: username,
      contextUsed: {
        memory: !!context?.memory,
        skills: context?.skills?.length || 0,
        summaries: context?.summaries?.length || 0,
        assets: context?.assets?.length || 0,
      },
    });

    console.log(`Responded to @${username} with context-aware message`);
  } catch (err) {
    console.error(`Failed to handle mention: ${err.message}`);
    // Fall back to simple response
    try {
      const simpleResponse = await callClawdbotSimple(
        `User @${username} mentioned you: "${content}"`,
      );
      await postMessage(event.podId, simpleResponse, {
        source: 'clawd-bot',
        eventId: event._id,
        fallback: true,
      });
    } catch (fallbackErr) {
      console.error(`Fallback also failed: ${fallbackErr.message}`);
    }
  }

  return ackEvent(event._id);
};

/**
 * Handle integration summary events
 */
const handleSummaryEvent = async (event) => {
  const summaryContent = event.payload?.summary?.content || event.payload?.summary;
  if (!summaryContent) {
    return ackEvent(event._id);
  }

  console.log(`Processing integration summary for pod ${event.podId}`);

  try {
    const response = await callClawdbotSimple(summaryContent);
    await postMessage(event.podId, response, {
      source: 'clawd-bot',
      eventId: event._id,
    });
  } catch (err) {
    console.error(`Failed to handle summary: ${err.message}`);
  }

  return ackEvent(event._id);
};

/**
 * Main event handler - routes to specific handlers
 */
const handleEvent = async (event) => {
  // Handle chat.mention events (direct @mentions)
  if (event.type === 'chat.mention') {
    return handleMentionEvent(event);
  }

  // Handle integration summaries (original behavior)
  if (event?.payload?.summary?.content || event?.payload?.summary) {
    return handleSummaryEvent(event);
  }

  // Unknown event type - just ack it
  console.log(`Unknown event type: ${event.type}`);
  return ackEvent(event._id);
};

// ============================================================================
// Polling Loop
// ============================================================================

const poll = async () => {
  try {
    const events = await fetchEvents();
    for (const event of events) {
      await handleEvent(event);
    }
  } catch (error) {
    console.error('Clawd-bot bridge poll failed:', error.message);
  }
};

const intervalMs = parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10) || 5000;

console.log('Clawd 🐾 Bridge starting...');
console.log(`  Agent: ${agentName} (instance: ${instanceId})`);
console.log(`  Commonly API: ${baseUrl}`);
console.log(`  Gateway: ${gatewayUrl}`);
console.log(`  Poll interval: ${intervalMs}ms`);

// Initial connection test
fetchEvents()
  .then((events) => {
    console.log(`Clawd 🐾 Bridge connected. ${events.length} pending events.`);
  })
  .catch((err) => {
    console.error('Clawd 🐾 Bridge connection failed:', err.message);
  });

setInterval(poll, intervalMs);

// Export for testing
module.exports = {
  fetchEvents,
  postMessage,
  ackEvent,
  getAssembledContext,
  getRecentMessages,
  getRecentSummaries,
  writeMemory,
  handleEvent,
  handleMentionEvent,
  handleSummaryEvent,
};
