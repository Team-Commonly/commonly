const fs = require('fs');
const baseUrl = process.env.COMMONLY_BASE_URL || 'http://localhost:5000';
const token = process.env.COMMONLY_AGENT_TOKEN;
const userToken = process.env.COMMONLY_USER_TOKEN;
const configPath = process.env.COMMONLY_AGENT_CONFIG_PATH;

const loadConfigAccounts = () => {
  if (!configPath) return [];
  try {
    if (!fs.existsSync(configPath)) return [];
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    const accounts = data.accounts || {};
    return Object.entries(accounts).map(([id, account]) => ({
      id,
      ...account,
    }));
  } catch (error) {
    console.error('Failed to read COMMONLY_AGENT_CONFIG_PATH:', error.message);
    return [];
  }
};

const buildAccounts = () => {
  const configAccounts = loadConfigAccounts();
  if (configAccounts.length > 0) return configAccounts;
  if (token) {
    return [{
      id: 'default',
      runtimeToken: token,
      userToken,
      agentName: 'commonly-summarizer',
      instanceId: 'default',
    }];
  }
  return [];
};

const buildHeaders = (runtimeToken) => ({
  Authorization: `Bearer ${runtimeToken}`,
  'Content-Type': 'application/json',
});

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

const fetchEvents = async (runtimeToken) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events`, {
    headers: buildHeaders(runtimeToken),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch events: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.events || [];
};

const postMessage = async (runtimeToken, podId, content, metadata = {}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers: buildHeaders(runtimeToken),
    body: JSON.stringify({ content, metadata }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
  return res.json();
};

const ackEvent = async (runtimeToken, eventId) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events/${eventId}/ack`, {
    method: 'POST',
    headers: buildHeaders(runtimeToken),
  });
  if (!res.ok) {
    throw new Error(`Failed to ack event: ${res.status}`);
  }
};

const handleEvent = async (runtimeToken, event) => {
  if (!event?.payload?.summary) {
    return ackEvent(runtimeToken, event._id);
  }

  const content = formatIntegrationSummary(event.payload.summary, event.payload.source);
  if (!content) {
    return ackEvent(runtimeToken, event._id);
  }

  await postMessage(runtimeToken, event.podId, content, {
    source: 'commonly-bot',
    eventId: event._id,
  });

  return ackEvent(runtimeToken, event._id);
};

const pollAccount = async (account) => {
  try {
    if (!account.runtimeToken) {
      return;
    }
    const events = await fetchEvents(account.runtimeToken);
    for (const event of events) {
      await handleEvent(account.runtimeToken, event);
    }
  } catch (error) {
    console.error(`Commonly Bot poll failed (${account.id}):`, error.message);
  }
};

const intervalMs = parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10) || 5000;

console.log('Commonly Bot starting...');
console.log(`  Commonly API: ${baseUrl}`);
console.log(`  Poll interval: ${intervalMs}ms`);
if (configPath) {
  console.log(`  Config: ${configPath}`);
}

if (userToken) {
  console.log('  User token: configured (single account)');
} else {
  console.log('  User token: not set (runtime-only mode)');
}

const initialAccounts = buildAccounts();
if (initialAccounts.length === 0) {
  console.error('No agent tokens configured. Set COMMONLY_AGENT_TOKEN or COMMONLY_AGENT_CONFIG_PATH.');
  process.exit(1);
}

Promise.all(
  initialAccounts.map((account) => (
    fetchEvents(account.runtimeToken)
      .then((events) => {
        console.log(`Commonly Bot connected (${account.id}). ${events.length} pending events.`);
      })
      .catch((err) => {
        console.error(`Commonly Bot connection failed (${account.id}):`, err.message);
      })
  )),
).catch(() => {});

let isPolling = false;
setInterval(async () => {
  if (isPolling) return;
  isPolling = true;
  const accounts = buildAccounts();
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop
    await pollAccount(account);
  }
  isPolling = false;
}, intervalMs);
