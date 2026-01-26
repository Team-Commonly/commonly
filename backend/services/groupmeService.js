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

module.exports = {
  sendMessage,
};
