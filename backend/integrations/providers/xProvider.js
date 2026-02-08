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
const DEFAULT_TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';

const getOAuthClientConfig = () => ({
  clientId: process.env.X_OAUTH_CLIENT_ID || process.env.X_CLIENT_ID || '',
  clientSecret: process.env.X_OAUTH_CLIENT_SECRET || process.env.X_CLIENT_SECRET || '',
  tokenEndpoint: process.env.X_OAUTH_TOKEN_URL || DEFAULT_TOKEN_ENDPOINT,
});

const buildOAuthTokenHeaders = ({ clientId, clientSecret }) => {
  if (!clientId) {
    throw new Error('Missing X OAuth client id');
  }
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
};

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

async function fetchXTweets({
  apiBase, accessToken, userId, sinceId, maxResults, exclude,
}) {
  const params = {
    max_results: maxResults || 5,
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

async function fetchXFollowing({
  apiBase,
  accessToken,
  userId,
  maxResults = 100,
}) {
  const response = await axios.get(`${apiBase}/users/${userId}/following`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      max_results: maxResults,
      'user.fields': 'id,name,username,profile_image_url',
    },
  });
  return Array.isArray(response?.data?.data) ? response.data.data : [];
}

async function refreshXAccessToken({ refreshToken }) {
  const {
    clientId,
    clientSecret,
    tokenEndpoint,
  } = getOAuthClientConfig();
  if (!refreshToken) {
    throw new Error('Missing X refresh token');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const response = await axios.post(tokenEndpoint, body.toString(), {
    headers: buildOAuthTokenHeaders({ clientId, clientSecret }),
  });
  return response.data || {};
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
  const followingWhitelistUserIds = Array.isArray(config.followingWhitelistUserIds)
    ? config.followingWhitelistUserIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const followFromAuthenticatedUser = config.followFromAuthenticatedUser === true;

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
      let { accessToken } = config;
      let { refreshToken } = config;
      const parsedMaxResults = Number(config.maxResults);
      const effectiveMaxResults = Number.isFinite(parsedMaxResults)
        ? Math.min(Math.max(Math.trunc(parsedMaxResults), 1), 5)
        : 5;
      const parsedFollowingMaxUsers = Number(config.followingMaxUsers);
      const followingMaxUsers = Number.isFinite(parsedFollowingMaxUsers)
        ? Math.min(Math.max(Math.trunc(parsedFollowingMaxUsers), 1), 100)
        : 5;
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

      if (followFromAuthenticatedUser && config.userId) {
        try {
          const followingUsers = await fetchXFollowing({
            apiBase,
            accessToken,
            userId: config.userId,
            maxResults: followingMaxUsers,
          });
          const whitelistSet = new Set(followingWhitelistUserIds.map(String));
          const filteredFollowing = whitelistSet.size > 0
            ? followingUsers.filter((user) => whitelistSet.has(String(user?.id || '')))
            : followingUsers;
          filteredFollowing.forEach((user) => {
            if (user?.id) {
              resolvedUsers.push(user);
            }
          });
        } catch (error) {
          // Non-fatal: keep main-account and explicit follow sync working even if following lookup fails.
          console.warn('[xProvider] failed to fetch following list:', error?.response?.data || error?.message || error);
        }
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

      let tokenRefreshed = false;
      let refreshMeta = null;
      let tweetsByUser;
      try {
        tweetsByUser = await Promise.all(
          uniqueUsers.map(async (user) => {
            const tweets = await fetchXTweets({
              apiBase,
              accessToken,
              userId: user.id,
              sinceId: followUserIds.length || followUsernames.length || followFromAuthenticatedUser
                ? undefined
                : sinceId,
              maxResults: effectiveMaxResults,
              exclude,
            });
            return { user, tweets };
          }),
        );
      } catch (error) {
        if (error?.response?.status === 401 && refreshToken) {
          const refreshed = await refreshXAccessToken({ refreshToken });
          accessToken = refreshed.access_token || accessToken;
          refreshToken = refreshed.refresh_token || refreshToken;
          tokenRefreshed = Boolean(refreshed.access_token);
          refreshMeta = {
            tokenType: refreshed.token_type || null,
            expiresIn: refreshed.expires_in || null,
            scope: refreshed.scope || null,
          };
          tweetsByUser = await Promise.all(
            uniqueUsers.map(async (user) => {
              const tweets = await fetchXTweets({
                apiBase,
                accessToken,
                userId: user.id,
                sinceId: followUserIds.length || followUsernames.length || followFromAuthenticatedUser
                  ? undefined
                  : sinceId,
                maxResults: effectiveMaxResults,
                exclude,
              });
              return { user, tweets };
            }),
          );
        } else {
          throw error;
        }
      }

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
          watchedViaFollowing: followFromAuthenticatedUser,
          tokenRefreshed,
          refreshedAccessToken: tokenRefreshed ? accessToken : undefined,
          refreshedRefreshToken: tokenRefreshed ? refreshToken : undefined,
          refreshedTokenType: refreshMeta?.tokenType || undefined,
          refreshedExpiresIn: refreshMeta?.expiresIn || undefined,
          refreshedScope: refreshMeta?.scope || undefined,
        },
      };
    },

    async health() {
      const { accessToken } = config;
      if (!accessToken || (!config.username && !config.userId)) {
        return { ok: false, error: 'Missing X access configuration' };
      }
      try {
        if (config.userId) {
          await fetchXTweets({
            apiBase,
            accessToken,
            userId: config.userId,
            maxResults: 5,
            exclude: config.exclude || 'replies,retweets',
          });
          return { ok: true };
        }

        const username = sanitizedUsername;
        if (!username) {
          return { ok: false, error: 'Missing X username' };
        }
        const user = await fetchXUser({ apiBase, accessToken, username });
        if (!user?.id) {
          return { ok: false, error: 'X user lookup failed' };
        }
        await fetchXTweets({
          apiBase,
          accessToken,
          userId: user.id,
          maxResults: 5,
          exclude: config.exclude || 'replies,retweets',
        });
        return { ok: true };
      } catch (error) {
        const status = error?.response?.status;
        const detail = error?.response?.data?.detail
          || error?.response?.data?.title
          || error?.response?.data?.error
          || error?.message
          || 'Failed to validate X credentials';
        return {
          ok: false,
          error: status ? `X API ${status}: ${detail}` : detail,
          status,
        };
      }
    },

    async publishPost({ text, hashtags = [], sourceUrl } = {}) {
      const { accessToken } = config;
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
