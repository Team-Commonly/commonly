const axios = require('axios');

class SlackApi {
  constructor(botToken) {
    this.client = axios.create({
      baseURL: 'https://slack.com/api',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async postMessage(channel, text, blocks) {
    const res = await this.client.post('/chat.postMessage', {
      channel,
      text,
      blocks,
    });
    return res.data;
  }

  async history(channel, oldest, latest, limit = 200) {
    const params = { channel, limit };
    if (oldest) params.oldest = oldest;
    if (latest) params.latest = latest;
    const res = await this.client.get('/conversations.history', { params });
    return res.data;
  }
}

module.exports = SlackApi;
