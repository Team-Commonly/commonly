const baseUrl = process.env.COMMONLY_BASE_URL || 'http://backend:5000';
const token = process.env.COMMONLY_AGENT_TOKEN;
const gatewayUrl = process.env.CLAWDBOT_GATEWAY_URL || 'http://clawdbot-gateway:18789';
const gatewayToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
const agentId = process.env.CLAWDBOT_AGENT_ID || 'main';
const model = process.env.CLAWDBOT_MODEL || `moltbot:${agentId}`;

if (!token) {
  console.error('COMMONLY_AGENT_TOKEN is required.');
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

const fetchEvents = async () => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events`, { headers: commonlyHeaders });
  if (!res.ok) {
    throw new Error(`Failed to fetch events: ${res.status}`);
  }
  const data = await res.json();
  return data.events || [];
};

const postMessage = async (podId, content, metadata = {}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers: commonlyHeaders,
    body: JSON.stringify({ content, metadata }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
  return res.json();
};

const ackEvent = async (eventId) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events/${eventId}/ack`, {
    method: 'POST',
    headers: commonlyHeaders,
  });
  if (!res.ok) {
    throw new Error(`Failed to ack event: ${res.status}`);
  }
};

const callClawdbot = async (summary) => {
  const prompt = `You are a helpful assistant posting into a Commonly pod.\n\nSummarize and respond to this integration update in 2-3 sentences, optionally with 1 action item if relevant.\n\nUpdate:\n${summary}`;

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
    throw new Error(`Clawdbot request failed: ${res.status}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
  if (!content) {
    throw new Error('Clawdbot response missing content');
  }
  return String(content).trim();
};

const handleEvent = async (event) => {
  if (!event?.payload?.summary?.content && !event?.payload?.summary) {
    return ackEvent(event._id);
  }

  const summaryContent = event.payload.summary.content || event.payload.summary;
  if (!summaryContent) {
    return ackEvent(event._id);
  }

  const response = await callClawdbot(summaryContent);
  await postMessage(event.podId, response, {
    source: 'clawdbot-bridge',
    eventId: event._id,
  });

  return ackEvent(event._id);
};

const poll = async () => {
  try {
    const events = await fetchEvents();
    for (const event of events) {
      await handleEvent(event);
    }
  } catch (error) {
    console.error('Clawdbot bridge poll failed:', error.message);
  }
};

const intervalMs = parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10) || 5000;

console.log('Clawdbot Bridge starting...');
console.log(`  Commonly API: ${baseUrl}`);
console.log(`  Gateway: ${gatewayUrl}`);
console.log(`  Poll interval: ${intervalMs}ms`);

// Initial connection test
fetchEvents()
  .then((events) => {
    console.log(`Clawdbot Bridge connected. ${events.length} pending events.`);
  })
  .catch((err) => {
    console.error('Clawdbot Bridge connection failed:', err.message);
  });

setInterval(poll, intervalMs);
