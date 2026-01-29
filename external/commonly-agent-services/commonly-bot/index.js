const baseUrl = process.env.COMMONLY_BASE_URL || 'http://localhost:5000';
const token = process.env.COMMONLY_AGENT_TOKEN;

if (!token) {
  console.error('COMMONLY_AGENT_TOKEN is required.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const formatIntegrationSummary = (summary, sourceOverride) => {
  if (!summary) return '';
  const source = sourceOverride || summary.source || 'external';
  const sourceLabel = summary.sourceLabel || 'External';
  const channelName = summary.channelName || 'channel';
  const channelUrl = summary.channelUrl || null;
  const messageCount = summary.messageCount || 0;
  const startTime = summary.timeRange?.start
    ? new Date(summary.timeRange.start).toISOString()
    : null;
  const endTime = summary.timeRange?.end
    ? new Date(summary.timeRange.end).toISOString()
    : null;

  return `[BOT_MESSAGE]${JSON.stringify({
    type: source === 'discord' ? 'discord-summary' : 'integration-summary',
    source,
    sourceLabel,
    channel: channelName,
    channelUrl,
    messageCount,
    timeRange: { start: startTime, end: endTime },
    summary: summary.content,
    server: summary.serverName,
  })}`;
};

const fetchEvents = async () => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch events: ${res.status}`);
  }
  const data = await res.json();
  return data.events || [];
};

const postMessage = async (podId, content, metadata = {}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers,
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
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to ack event: ${res.status}`);
  }
};

const handleEvent = async (event) => {
  if (!event?.payload?.summary) {
    return ackEvent(event._id);
  }

  const content = formatIntegrationSummary(event.payload.summary, event.payload.source);
  if (!content) {
    return ackEvent(event._id);
  }

  await postMessage(event.podId, content, {
    source: 'commonly-bot',
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
    console.error('Commonly Bot poll failed:', error.message);
  }
};

const intervalMs = parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10) || 5000;
setInterval(poll, intervalMs);
poll();
