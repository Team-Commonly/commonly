/**
 * OpenClaw Bridge - Commonly Channel Integration
 *
 * This service bridges Commonly pods with the OpenClaw AI runtime (Cuz 🦞), enabling:
 * - Direct @cuz or @clawd mentions in pod chat
 * - Full context assembly using Commonly's Bot API
 * - Context-aware responses with pod memory, skills, and summaries
 *
 * Authentication: Uses a bot user API token (cm_*) with scoped permissions
 * Required scopes: agent:events:read, agent:events:ack, agent:context:read,
 *                  agent:messages:read, agent:messages:write
 */

const baseUrl = process.env.COMMONLY_BASE_URL || 'http://backend:5000';
const userToken = process.env.COMMONLY_USER_TOKEN;
const agentToken = process.env.COMMONLY_AGENT_TOKEN;
const gatewayUrl = process.env.CLAWDBOT_GATEWAY_URL || 'http://clawdbot-gateway:18789';
const gatewayToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
const runtimeAgentId = process.env.CLAWDBOT_AGENT_ID || 'main';
const model = process.env.CLAWDBOT_MODEL || `moltbot:${runtimeAgentId}`;
// agentType = the agent runtime type (openclaw, commonly-summarizer, etc.)
const agentType = process.env.CLAWDBOT_AGENT_TYPE || process.env.CLAWDBOT_AGENT_NAME || 'openclaw';
const instanceId = process.env.CLAWDBOT_INSTANCE_ID || 'default';
// displayName for this instance (defaults to official name based on type)
const displayName = process.env.CLAWDBOT_DISPLAY_NAME || null;
const bridgeEnabled = process.env.CLAWDBOT_BRIDGE_ENABLED !== '0'
  && process.env.CLAWDBOT_BRIDGE_ENABLED !== 'false';

if (!bridgeEnabled) {
  console.log('Clawdbot bridge disabled (CLAWDBOT_BRIDGE_ENABLED=0).');
  process.exit(0);
}

if (!agentToken && !userToken) {
  console.error('COMMONLY_AGENT_TOKEN or COMMONLY_USER_TOKEN is required.');
  process.exit(1);
}

if (!gatewayToken) {
  console.error('CLAWDBOT_GATEWAY_TOKEN is required.');
  process.exit(1);
}

const botHeaders = userToken ? {
  Authorization: `Bearer ${userToken}`,
  'Content-Type': 'application/json',
} : null;

const runtimeHeaders = agentToken ? {
  Authorization: `Bearer ${agentToken}`,
  'Content-Type': 'application/json',
} : null;

const clawdbotHeaders = {
  Authorization: `Bearer ${gatewayToken}`,
  'Content-Type': 'application/json',
  'x-moltbot-agent-id': runtimeAgentId,
};

const processedEvents = new Set();

// ============================================================================
// Commonly Runtime API Functions (/api/agents/runtime/* endpoints)
// ============================================================================

const fetchRuntimeEvents = async () => {
  const url = new URL(`${baseUrl}/api/agents/runtime/events`);
  url.searchParams.append('agentName', agentType);
  url.searchParams.append('instanceId', instanceId);

  const res = await fetch(url, { headers: runtimeHeaders });
  if (!res.ok) {
    throw new Error(`Failed to fetch events: ${res.status}`);
  }
  const data = await res.json();
  return data.events || [];
};

const ackRuntimeEvent = async (eventId, result = null) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events/${eventId}/ack`, {
    method: 'POST',
    headers: runtimeHeaders,
    body: result ? JSON.stringify({ result }) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Failed to ack event: ${res.status}`);
  }
};

const postRuntimeMessage = async (podId, content, metadata = {}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers: runtimeHeaders,
    body: JSON.stringify({
      content,
      messageType: 'text',
      metadata: { ...metadata, agentType, instanceId },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
  return res.json();
};

const postRuntimeThreadComment = async (threadId, content) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/threads/${threadId}/comments`, {
    method: 'POST',
    headers: runtimeHeaders,
    body: JSON.stringify({
      content,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post thread comment: ${res.status}`);
  }
  return res.json();
};

const getRuntimeContext = async (podId, task = null) => {
  const url = new URL(`${baseUrl}/api/agents/runtime/pods/${podId}/context`);
  if (task) {
    url.searchParams.append('task', task);
  }
  const res = await fetch(url, { headers: runtimeHeaders });
  if (!res.ok) {
    console.warn(`Failed to get assembled context: ${res.status}`);
    return null;
  }
  return res.json();
};

const getRuntimeMessages = async (podId, limit = 10) => {
  const url = new URL(`${baseUrl}/api/agents/runtime/pods/${podId}/messages`);
  url.searchParams.append('limit', limit.toString());
  const res = await fetch(url, { headers: runtimeHeaders });
  if (!res.ok) {
    console.warn(`Failed to get recent messages: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.messages || [];
};

// ============================================================================
// Commonly Bot API Functions (/api/agents/runtime/bot/* endpoints)
// ============================================================================

/**
 * Fetch pending events for this agent type using bot user API
 * Uses /api/agents/runtime/bot/events with scoped token
 */
const fetchEvents = async () => {
  if (runtimeHeaders) {
    return fetchRuntimeEvents();
  }
  const url = new URL(`${baseUrl}/api/agents/runtime/bot/events`);
  url.searchParams.append('agentName', agentType);
  url.searchParams.append('instanceId', instanceId);

  const res = await fetch(url, { headers: botHeaders });
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
  if (runtimeHeaders) {
    return postRuntimeMessage(podId, content, metadata);
  }
  const res = await fetch(`${baseUrl}/api/agents/runtime/bot/pods/${podId}/messages`, {
    method: 'POST',
    headers: botHeaders,
    body: JSON.stringify({
      agentName: agentType,
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
 * Post thread comment using bot/runtime API
 */
const postThreadComment = async (threadId, content, podId = null) => {
  if (runtimeHeaders) {
    return postRuntimeThreadComment(threadId, content);
  }
  const res = await fetch(`${baseUrl}/api/agents/runtime/bot/threads/${threadId}/comments`, {
    method: 'POST',
    headers: botHeaders,
    body: JSON.stringify({
      agentName: agentType,
      instanceId,
      content,
      podId,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post thread comment: ${res.status}`);
  }
  return res.json();
};

/**
 * Acknowledge event via bot API
 */
const ackEvent = async (eventId, result = null) => {
  if (runtimeHeaders) {
    return ackRuntimeEvent(eventId, result);
  }
  const res = await fetch(`${baseUrl}/api/agents/runtime/bot/events/${eventId}/ack`, {
    method: 'POST',
    headers: botHeaders,
    body: JSON.stringify({
      agentName: agentType,
      instanceId,
      ...(result ? { result } : {}),
    }),
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
  if (runtimeHeaders) {
    return getRuntimeContext(podId, task);
  }
  const url = new URL(`${baseUrl}/api/agents/runtime/bot/pods/${podId}/context`);
  url.searchParams.append('agentName', agentType);
  url.searchParams.append('instanceId', instanceId);
  if (task) {
    url.searchParams.append('task', task);
  }

  const res = await fetch(url, { headers: botHeaders });
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
  if (runtimeHeaders) {
    return getRuntimeMessages(podId, limit);
  }
  const url = new URL(`${baseUrl}/api/agents/runtime/bot/pods/${podId}/messages`);
  url.searchParams.append('agentName', agentType);
  url.searchParams.append('instanceId', instanceId);
  url.searchParams.append('limit', limit.toString());

  const res = await fetch(url, { headers: botHeaders });
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
  if (!botHeaders) {
    return [];
  }
  const res = await fetch(`${baseUrl}/api/v1/pods/${podId}/summaries?hours=${hours}`, {
    headers: botHeaders,
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
  if (!botHeaders) {
    return null;
  }
  const res = await fetch(`${baseUrl}/api/v1/memory/${podId}`, {
    method: 'POST',
    headers: botHeaders,
    body: JSON.stringify({
      target,
      content,
      tags,
      source: { ...source, agentType, instanceId },
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
// OpenClaw AI Integration
// ============================================================================

// Get persona name based on agent type and display name
const getPersonaName = () => {
  if (displayName) return displayName;
  if (agentType === 'openclaw') return 'Cuz 🦞';
  return agentType;
};

const sanitizeReply = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.includes('NO_REPLY') || /no reply from agent\.?/i.test(text)) {
    return '';
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const filtered = lines.filter((line) => (
    !/^i (will|am|seem|see|checked|cannot|can’t|do not|don't|will try|will now|will respond|will ask)/i.test(line)
    && !/channel is required|unknown channel|unknown target|action send requires|missing_brave_api_key/i.test(line)
    && !/telegram|discord|slack|webchat|tool/i.test(line)
  ));
  if (filtered.length === 0) {
    return '';
  }
  const joined = filtered.join('\n');
  const firstParagraph = joined.split('\n\n')[0] || joined;
  return firstParagraph.trim();
};

/**
 * Call OpenClaw AI with full context
 */
const callClawdbotWithContext = async (userMessage, contextPrompt, conversationHistory) => {
  const personaName = getPersonaName();
  const systemPrompt = `You are ${personaName}, an AI assistant integrated into a Commonly pod.

You have access to the pod's context, memory, skills, and recent activity.
Use this information to provide helpful, contextual responses.

${contextPrompt}
${conversationHistory}

Guidelines:
- Be friendly and conversational
- Reference pod context when relevant
- Keep responses concise but helpful
- Do not mention tools, channels, or internal errors
- Reply with the final answer only
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
      tools: [],
      tool_choice: 'none',
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenClaw request failed: ${res.status}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!content) {
    throw new Error('OpenClaw response missing content');
  }
  return sanitizeReply(content);
};

/**
 * Simple call for integration summaries
 */
const callClawdbotSimple = async (summary) => {
  const personaName = getPersonaName();
  const prompt = `You are ${personaName}, a helpful assistant posting into a Commonly pod.

Summarize and respond to this integration update in 2-3 sentences, optionally with 1 action item if relevant.

Update:
${summary}`;

  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: clawdbotHeaders,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      tool_choice: 'none',
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenClaw request failed: ${res.status}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!content) {
    throw new Error('OpenClaw response missing content');
  }
  return sanitizeReply(content);
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
    return ackEvent(event._id, { outcome: 'no_action', reason: 'empty_mention_content' });
  }
  if (processedEvents.has(event._id)) {
    return ackEvent(event._id, { outcome: 'skipped', reason: 'duplicate_event_id' });
  }
  processedEvents.add(event._id);

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

    // Call OpenClaw with full context
    const response = await callClawdbotWithContext(
      `@${username} asks: ${content}`,
      contextPrompt,
      conversationHistory,
    );

    if (!response) {
      return ackEvent(event._id, { outcome: 'no_action', reason: 'empty_model_response' });
    }

    // Post response to pod
    const posted = await postMessage(event.podId, response, {
      source: agentType,
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
    return ackEvent(event._id, {
      outcome: 'posted',
      reason: 'mention_response_posted',
      messageId: posted?.id || posted?._id || null,
    });
  } catch (err) {
    console.error(`Failed to handle mention: ${err.message}`);
    // Fall back to simple response
    try {
      const simpleResponse = await callClawdbotSimple(
        `User @${username} mentioned you: "${content}"`,
      );
      if (simpleResponse) {
        const posted = await postMessage(event.podId, simpleResponse, {
          source: agentType,
          eventId: event._id,
          fallback: true,
        });
        return ackEvent(event._id, {
          outcome: 'posted',
          reason: 'mention_fallback_posted',
          messageId: posted?.id || posted?._id || null,
        });
      }
    } catch (fallbackErr) {
      console.error(`Fallback also failed: ${fallbackErr.message}`);
    }
    return ackEvent(event._id, { outcome: 'error', reason: err.message || 'mention_handler_failed' });
  }
};

/**
 * Handle thread.mention events (mentions inside post comments)
 */
const handleThreadMentionEvent = async (event) => {
  const payload = event.payload || {};
  const { content, username } = payload;
  const thread = payload.thread || {};
  const threadId = thread.postId || payload.threadId;

  if (!threadId || !content) {
    return ackEvent(event._id, { outcome: 'no_action', reason: 'thread_context_missing' });
  }
  if (processedEvents.has(event._id)) {
    return ackEvent(event._id, { outcome: 'skipped', reason: 'duplicate_event_id' });
  }
  processedEvents.add(event._id);

  console.log(`Processing thread mention from @${username}: "${content.substring(0, 50)}..."`);

  try {
    const [context, messages] = await Promise.all([
      getAssembledContext(event.podId, content),
      getRecentMessages(event.podId, 8),
    ]);

    const contextPrompt = buildContextPrompt(context);
    const conversationHistory = buildConversationHistory(messages);
    const postContent = thread?.postContent || '';
    const commentText = thread?.commentText || content;

    const response = await callClawdbotWithContext(
      [
        `Thread context:`,
        `Post: ${postContent}`,
        `Comment: ${commentText}`,
        `User @${username} mentioned you in a thread. Reply directly to the comment with helpful, concise guidance.`,
      ].join('\n'),
      contextPrompt,
      conversationHistory,
    );

    if (!response) {
      return ackEvent(event._id, { outcome: 'no_action', reason: 'empty_model_response' });
    }

    await postThreadComment(threadId, response, event.podId);
    console.log(`Responded to thread mention from @${username}`);
    return ackEvent(event._id, {
      outcome: 'posted',
      reason: 'thread_response_posted',
      messageId: threadId,
    });
  } catch (err) {
    console.error(`Failed to handle thread mention: ${err.message}`);
    return ackEvent(event._id, { outcome: 'error', reason: err.message || 'thread_handler_failed' });
  }
};

/**
 * Handle integration summary events
 */
const handleSummaryEvent = async (event) => {
  const summaryContent = event.payload?.summary?.content || event.payload?.summary;
  if (!summaryContent) {
    return ackEvent(event._id, { outcome: 'no_action', reason: 'summary_missing_content' });
  }
  if (processedEvents.has(event._id)) {
    return ackEvent(event._id, { outcome: 'skipped', reason: 'duplicate_event_id' });
  }
  processedEvents.add(event._id);

  console.log(`Processing integration summary for pod ${event.podId}`);

  try {
    const response = await callClawdbotSimple(summaryContent);
    if (response) {
      const posted = await postMessage(event.podId, response, {
        source: agentType,
        eventId: event._id,
      });
      return ackEvent(event._id, {
        outcome: 'posted',
        reason: 'summary_response_posted',
        messageId: posted?.id || posted?._id || null,
      });
    }
    return ackEvent(event._id, { outcome: 'no_action', reason: 'summary_model_empty' });
  } catch (err) {
    console.error(`Failed to handle summary: ${err.message}`);
    return ackEvent(event._id, { outcome: 'error', reason: err.message || 'summary_handler_failed' });
  }
};

/**
 * Main event handler - routes to specific handlers
 */
const handleEvent = async (event) => {
  if (event.type === 'thread.mention') {
    return handleThreadMentionEvent(event);
  }

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
  return ackEvent(event._id, { outcome: 'skipped', reason: `unsupported_event_type:${event.type}` });
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
    console.error('OpenClaw bridge poll failed:', error.message);
  }
};

const intervalMs = parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10) || 5000;
const personaName = getPersonaName();

console.log(`${personaName} Bridge starting...`);
console.log(`  Agent Type: ${agentType} (instance: ${instanceId})`);
console.log(`  Display Name: ${personaName}`);
console.log(`  Commonly API: ${baseUrl}`);
console.log(`  Gateway: ${gatewayUrl}`);
console.log(`  Poll interval: ${intervalMs}ms`);

// Initial connection test
fetchEvents()
  .then((events) => {
    console.log(`${personaName} Bridge connected. ${events.length} pending events.`);
  })
  .catch((err) => {
    console.error(`${personaName} Bridge connection failed:`, err.message);
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
  getPersonaName,
};
