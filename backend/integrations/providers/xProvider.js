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
  const followUsernames = Array.isArray(config.followUsernames)
    ? config.followUsernames.map((item) => String(item || '').trim().replace(/^@/, '')).filter(Boolean)
    : [];
  const followUserIds = Array.isArray(config.followUserIds)
    ? config.followUserIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

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

    async syncRecent({ sinceId, sinceTimestamp } = {}) {
      const accessToken = config.accessToken;
      const maxResults = config.maxResults;
      const exclude = config.exclude || 'replies,retweets';
      if (!accessToken) {
        throw new Error('Missing X access token');
      }

      const resolvedUsers = [];

      if (config.userId) {
        resolvedUsers.push({
          id: config.userId,
          username: config.username,
          name: config.username,
        });
      } else if (sanitizedUsername) {
        const primaryUser = await fetchXUser({
          apiBase,
          accessToken,
          username: sanitizedUsername,
        });
        if (primaryUser?.id) resolvedUsers.push(primaryUser);
      }

      if (followUserIds.length > 0) {
        followUserIds.forEach((id) => {
          resolvedUsers.push({ id });
        });
      }

      if (followUsernames.length > 0) {
        const extraUsers = await Promise.all(
          followUsernames.map((username) => (
            fetchXUser({
              apiBase,
              accessToken,
              username,
            }).catch(() => null)
          )),
        );
        extraUsers.filter((user) => user?.id).forEach((user) => {
          resolvedUsers.push(user);
        });
      }

      const uniqueUsers = Array.from(
        resolvedUsers.reduce((map, user) => {
          if (!user?.id) return map;
          map.set(String(user.id), user);
          return map;
        }, new Map()).values(),
      );

      if (!uniqueUsers.length) {
        throw new Error('Missing X userId/username');
      }

      const tweetsByUser = await Promise.all(
        uniqueUsers.map(async (user) => {
          const tweets = await fetchXTweets({
            apiBase,
            accessToken,
            userId: user.id,
            sinceId: followUserIds.length || followUsernames.length ? undefined : sinceId,
            maxResults,
            exclude,
          });
          return { user, tweets };
        }),
      );

      const sinceDate = sinceTimestamp ? new Date(sinceTimestamp) : null;
      const messages = tweetsByUser
        .flatMap(({ user, tweets }) => (
          tweets.map((tweet) => normalizeXTweet(tweet, user)).filter(Boolean)
        ))
        .filter((message) => {
          if (!sinceDate || Number.isNaN(sinceDate.valueOf())) return true;
          const ts = new Date(message.timestamp);
          if (Number.isNaN(ts.valueOf())) return true;
          return ts > sinceDate;
        })
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      return {
        success: true,
        messageCount: messages.length,
        messages,
        content: messages.length ? `Fetched ${messages.length} post(s) from X` : 'No new posts',
        meta: {
          userId: uniqueUsers[0]?.id,
          username: uniqueUsers[0]?.username || sanitizedUsername,
          watchedUsers: uniqueUsers.length,
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

    async publishPost({ text, hashtags = [], sourceUrl } = {}) {
      const accessToken = config.accessToken;
      if (!accessToken) {
        throw new Error('Missing X access token');
      }

      const baseText = String(text || '').trim();
      if (!baseText) {
        throw new Error('text is required for X publishing');
      }

      const normalizedTags = Array.isArray(hashtags)
        ? hashtags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 4)
        : [];
      const sourceSuffix = sourceUrl ? `\n\nSource: ${String(sourceUrl).trim()}` : '';
      const tagSuffix = normalizedTags.length ? `\n\n${normalizedTags.join(' ')}` : '';
      let tweetText = `${baseText}${tagSuffix}${sourceSuffix}`.trim();
      if (tweetText.length > 280) {
        tweetText = `${tweetText.slice(0, 277)}...`;
      }

      const response = await axios.post(
        `${apiBase}/tweets`,
        { text: tweetText },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      const id = response?.data?.data?.id || null;
      return {
        success: true,
        provider: 'x',
        externalId: id,
        url: buildXPostUrl(sanitizedUsername || config.username, id),
        text: tweetText,
      };
    },
  };
}

module.exports = createXProvider;
