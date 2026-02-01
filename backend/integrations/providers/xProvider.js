const axios = require('axios');
const { manifests } = require('../manifests');

let ValidationError;
let validateRequiredConfig;
try {
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
  // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
  ({ validateRequiredConfig } = require('../../../packages/integration-sdk/src/manifest'));
} catch (err) {
  ValidationError = class extends Error {};
  validateRequiredConfig = (config, manifest) => {
    const required = manifest?.requiredConfig || [];
    const missing = required.filter((f) => !config?.[f]);
    if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
  };
}

const DEFAULT_API_BASE = 'https://api.x.com/2';

const buildXPostUrl = (username, tweetId) => {
  if (!username || !tweetId) return null;
  return `https://x.com/${username}/status/${tweetId}`;
};

async function fetchXUser({ apiBase, accessToken, username }) {
  const response = await axios.get(`${apiBase}/users/by/username/${username}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { 'user.fields': 'id,name,username,profile_image_url' },
  });
  return response.data?.data || null;
}

async function fetchXTweets({ apiBase, accessToken, userId, sinceId, maxResults, exclude }) {
  const params = {
    max_results: maxResults || 20,
    'tweet.fields': 'created_at,author_id',
  };
  if (exclude) {
    params.exclude = exclude;
  }
  if (sinceId) {
    params.since_id = sinceId;
  }
  const response = await axios.get(`${apiBase}/users/${userId}/tweets`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return response.data?.data || [];
}

function normalizeXTweet(tweet, user = {}) {
  if (!tweet) return null;
  const username = user.username || tweet.username;
  const authorName = username ? `@${username}` : (user.name || 'Unknown');
  const authorId = tweet.author_id || user.id || 'unknown';
  const timestamp = tweet.created_at || new Date().toISOString();
  const url = buildXPostUrl(username, tweet.id);

  return {
    source: 'x',
    externalId: tweet.id ? String(tweet.id) : undefined,
    authorId: String(authorId),
    authorName,
    content: tweet.text || '',
    timestamp,
    attachments: [],
    metadata: {
      userId: user.id || tweet.author_id,
      username,
      url,
      authorUrl: username ? `https://x.com/${username}` : undefined,
    },
    raw: tweet,
  };
}

function createXProvider(integration) {
  const config = integration?.config || {};
  const apiBase = config.apiBase || process.env.X_API_BASE_URL || DEFAULT_API_BASE;
  const sanitizedUsername = config.username ? config.username.replace(/^@/, '') : '';

  return {
    async validateConfig() {
      try {
        validateRequiredConfig(config, manifests.x);
      } catch (err) {
        throw new ValidationError(err.message);
      }
    },

    getWebhookHandlers() {
      return {
        verify: (req, res) => res.sendStatus(200),
        events: (req, res) => res.sendStatus(200),
      };
    },

    async ingestEvent(payload) {
      if (!payload) return [];
      const items = Array.isArray(payload.data) ? payload.data : [payload.tweet || payload];
      const user = payload.user || payload.includes?.users?.[0] || {};
      return items.map((tweet) => normalizeXTweet(tweet, user)).filter(Boolean);
    },

    async syncRecent({ sinceId } = {}) {
      const accessToken = config.accessToken;
      const maxResults = config.maxResults;
      const exclude = config.exclude || 'replies,retweets';
      if (!accessToken) {
        throw new Error('Missing X access token');
      }

      let resolvedUser = null;
      if (config.userId) {
        resolvedUser = {
          id: config.userId,
          username: config.username,
          name: config.username,
        };
      } else if (sanitizedUsername) {
        resolvedUser = await fetchXUser({
          apiBase,
          accessToken,
          username: sanitizedUsername,
        });
      }

      if (!resolvedUser?.id) {
        throw new Error('Missing X userId/username');
      }

      const tweets = await fetchXTweets({
        apiBase,
        accessToken,
        userId: resolvedUser.id,
        sinceId,
        maxResults,
        exclude,
      });

      const messages = tweets
        .map((tweet) => normalizeXTweet(tweet, resolvedUser))
        .filter(Boolean);

      return {
        success: true,
        messageCount: messages.length,
        messages,
        content: messages.length ? `Fetched ${messages.length} post(s) from X` : 'No new posts',
        meta: {
          userId: resolvedUser.id,
          username: resolvedUser.username || sanitizedUsername,
        },
      };
    },

    async health() {
      const accessToken = config.accessToken;
      if (!accessToken || (!config.username && !config.userId)) {
        return { ok: false, error: 'Missing X access configuration' };
      }
      return { ok: true };
    },
  };
}

module.exports = createXProvider;
