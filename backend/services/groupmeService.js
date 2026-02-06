const axios = require('axios');

const GROUPME_API_BASE = 'https://api.groupme.com/v3';

async function sendMessage(botId, text) {
  if (!botId || !text) {
    return { success: false, error: 'Missing botId or text' };
  }

  try {
    const response = await axios.post(`${GROUPME_API_BASE}/bots/post`, {
      bot_id: botId,
      text,
    });

    console.log('GroupMe message sent', { botId, status: response.status });
    return { success: response.status === 202 };
  } catch (error) {
    console.error('Error sending GroupMe message:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

async function fetchMessages(options = {}) {
  const {
    groupId, accessToken, limit = 50, before, after,
  } = options;

  if (!groupId || !accessToken) {
    throw new Error('Missing groupId or accessToken');
  }

  const params = {
    token: accessToken,
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
  };

  if (before) params.before_id = before;
  if (after) params.after_id = after;

  const response = await axios.get(`${GROUPME_API_BASE}/groups/${groupId}/messages`, { params });
  const messages = response.data?.response?.messages || [];

  return messages.map((msg) => ({
    id: msg.id,
    authorId: msg.user_id || msg.sender_id,
    authorName: msg.name || 'Unknown',
    content: msg.text || '',
    timestamp: msg.created_at ? new Date(msg.created_at * 1000).toISOString() : null,
    attachments: (msg.attachments || []).map((att) => att.url || att.text).filter(Boolean),
    reactions: [],
    isBot: msg.sender_type === 'bot',
  }));
}

module.exports = {
  sendMessage,
  fetchMessages,
};
