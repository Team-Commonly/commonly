// eslint-disable-next-line global-require
const axios = require('axios');
// eslint-disable-next-line global-require
const { manifests } = require('../manifests');

interface XConfig {
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  username?: string;
  apiBase?: string;
  maxResults?: number;
  followUsernames?: unknown[];
  followUserIds?: unknown[];
  followingWhitelistUserIds?: unknown[];
  followFromAuthenticatedUser?: boolean;
  followingMaxUsers?: number;
  exclude?: string;
  tokenExpiresAt?: string;
  lastExternalIdsByUser?: Record<string, string>;
  [key: string]: unknown;
}

interface XUser {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
}

interface XTweet {
  id?: string | number;
  text?: string;
  created_at?: string;
  author_id?: string;
  username?: string;
}

interface NormalizedXPost {
  source: 'x';
  externalId: string | undefined;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
  attachments: unknown[];
  metadata: {
    userId: string | undefined;
    username: string | undefined;
    url: string | null;
    authorUrl: string | undefined;
  };
  raw: unknown;
}

interface SyncRecentOpts {
  sinceId?: string;
  sinceTimestamp?: string;
}

interface PublishPostOpts {
  text?: string;
  hashtags?: unknown[];
  sourceUrl?: string;
}

interface RefreshMeta {
  tokenType: string | null;
  expiresIn: number | null;
  scope: string | null;
}

interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
}

interface XProvider {
  validateConfig(): Promise<void>;
  getWebhookHandlers(): Record<string, (req: unknown, res: unknown) => unknown>;
  ingestEvent(payload: unknown): Promise<NormalizedXPost[]>;
  syncRecent(opts?: SyncRecentOpts): Promise<unknown>;
  health(): Promise<{ ok: boolean; error?: string; status?: number }>;
  publishPost(opts?: PublishPostOpts): Promise<{ success: boolean; provider: string; externalId: string | null; url: string | null; text: string }>;
}

let ValidationError: new (msg: string) => Error;
let validateRequiredConfig: (config: unknown, manifest: unknown) => void;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ ValidationError } = require('../../../packages/integration-sdk/src/errors'));
  // eslint-disable-next-line global-require, import/no-unresolved
  ({ validateRequiredConfig } = require('../../../packages/integration-sdk/src/manifest'));
} catch {
  ValidationError = class extends Error {};
  validateRequiredConfig = (config: unknown, manifest: unknown) => {
    const required = (manifest as { requiredConfig?: string[] })?.requiredConfig || [];
    const missing = required.filter((f) => !(config as Record<string, unknown>)?.[f]);
    if (missing.length) throw new ValidationError(`Missing fields: ${missing.join(', ')}`);
  };
}

const DEFAULT_API_BASE = 'https://api.x.com/2';
const DEFAULT_TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';

const getOAuthClientConfig = (): OAuthClientConfig => ({
  clientId: process.env.X_OAUTH_CLIENT_ID || process.env.X_CLIENT_ID || '',
  clientSecret: process.env.X_OAUTH_CLIENT_SECRET || process.env.X_CLIENT_SECRET || '',
  tokenEndpoint: process.env.X_OAUTH_TOKEN_URL || DEFAULT_TOKEN_ENDPOINT,
});

const buildOAuthTokenHeaders = ({ clientId, clientSecret }: { clientId: string; clientSecret: string }): Record<string, string> => {
  if (!clientId) {
    throw new Error('Missing X OAuth client id');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
};

const buildXPostUrl = (username: string | undefined, tweetId: string | number | null | undefined): string | null => {
  if (!username || !tweetId) return null;
  return `https://x.com/${username}/status/${tweetId}`;
};

async function fetchXUser({ apiBase, accessToken, username }: { apiBase: string; accessToken: string; username: string }): Promise<XUser | null> {
  const response = await axios.get(`${apiBase}/users/by/username/${username}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { 'user.fields': 'id,name,username,profile_image_url' },
  });
  return (response.data?.data as XUser) || null;
}

async function fetchXTweets({ apiBase, accessToken, userId, sinceId, maxResults, exclude }: {
  apiBase: string;
  accessToken: string;
  userId: string;
  sinceId?: string;
  maxResults?: number;
  exclude?: string;
}): Promise<XTweet[]> {
  const params: Record<string, unknown> = {
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
  return (response.data?.data as XTweet[]) || [];
}

async function fetchXFollowing({ apiBase, accessToken, userId, maxResults = 100 }: {
  apiBase: string;
  accessToken: string;
  userId: string;
  maxResults?: number;
}): Promise<XUser[]> {
  const response = await axios.get(`${apiBase}/users/${userId}/following`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      max_results: maxResults,
      'user.fields': 'id,name,username,profile_image_url',
    },
  });
  return Array.isArray(response?.data?.data) ? (response.data.data as XUser[]) : [];
}

const compareTweetIds = (left: unknown, right: unknown): number => {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a > b ? 1 : -1;
};

const pickNewestTweetId = (tweets: XTweet[] = []): string | null => {
  if (!Array.isArray(tweets) || !tweets.length) return null;
  let newest: string | null = null;
  tweets.forEach((tweet) => {
    const id = String(tweet?.id || '').trim();
    if (!id) return;
    if (!newest || compareTweetIds(id, newest) > 0) {
      newest = id;
    }
  });
  return newest;
};

async function refreshXAccessToken({ refreshToken }: { refreshToken: string }): Promise<Record<string, unknown>> {
  const { clientId, clientSecret, tokenEndpoint } = getOAuthClientConfig();
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
  return (response.data as Record<string, unknown>) || {};
}

function normalizeXTweet(tweet: unknown, user: Partial<XUser> = {}): NormalizedXPost | null {
  if (!tweet) return null;
  const t = tweet as XTweet;
  const username = user.username || t.username;
  const authorName = username ? `@${username}` : (user.name || 'Unknown');
  const authorId = t.author_id || user.id || 'unknown';
  const timestamp = t.created_at || new Date().toISOString();
  const url = buildXPostUrl(username, t.id);

  return {
    source: 'x',
    externalId: t.id ? String(t.id) : undefined,
    authorId: String(authorId),
    authorName,
    content: t.text || '',
    timestamp,
    attachments: [],
    metadata: {
      userId: user.id || t.author_id,
      username,
      url,
      authorUrl: username ? `https://x.com/${username}` : undefined,
    },
    raw: tweet,
  };
}

function createXProvider(integration: { _id: unknown; config?: XConfig; [key: string]: unknown }): XProvider {
  const config = (integration?.config || {}) as XConfig;
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
        const e = err as { message?: string };
        throw new ValidationError(e.message || 'Validation failed');
      }
    },

    getWebhookHandlers() {
      return {
        verify: (_req: unknown, res: { sendStatus: (n: number) => unknown }) => res.sendStatus(200),
        events: (_req: unknown, res: { sendStatus: (n: number) => unknown }) => res.sendStatus(200),
      };
    },

    async ingestEvent(payload: unknown): Promise<NormalizedXPost[]> {
      if (!payload) return [];
      const p = payload as { data?: unknown[]; tweet?: unknown; user?: unknown; includes?: { users?: unknown[] } };
      const items = Array.isArray(p.data) ? p.data : [p.tweet || payload];
      const user = (p.user || (p.includes?.users?.[0]) || {}) as Partial<XUser>;
      return items.map((tweet) => normalizeXTweet(tweet, user)).filter((x): x is NormalizedXPost => x !== null);
    },

    async syncRecent({ sinceId, sinceTimestamp } = {}): Promise<unknown> {
      let { accessToken } = config;
      let { refreshToken } = config;
      const previousSinceByUser = (config.lastExternalIdsByUser && typeof config.lastExternalIdsByUser === 'object')
        ? Object.entries(config.lastExternalIdsByUser).reduce<Record<string, string>>((acc, [key, value]) => {
          const normalizedKey = String(key || '').trim();
          const normalizedValue = String(value || '').trim();
          if (normalizedKey && normalizedValue) acc[normalizedKey] = normalizedValue;
          return acc;
        }, {})
        : {};
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

      const resolvedUsers: XUser[] = [];

      if (config.userId) {
        resolvedUsers.push({
          id: config.userId,
          username: config.username,
          name: config.username,
        });
      } else if (sanitizedUsername) {
        const primaryUser = await fetchXUser({ apiBase, accessToken, username: sanitizedUsername });
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
            fetchXUser({ apiBase, accessToken: accessToken!, username }).catch(() => null)
          )),
        );
        extraUsers.filter((user): user is XUser => !!(user?.id)).forEach((user) => {
          resolvedUsers.push(user);
        });
      }

      let tokenRefreshed = false;
      let refreshMeta: RefreshMeta | null = null;
      const proactiveRefreshThresholdSecondsRaw = Number(process.env.X_OAUTH_REFRESH_BUFFER_SECONDS);
      const proactiveRefreshThresholdSeconds = Number.isFinite(proactiveRefreshThresholdSecondsRaw)
        ? Math.max(0, Math.trunc(proactiveRefreshThresholdSecondsRaw))
        : 1800;

      const tryRefreshToken = async ({ force = false } = {}): Promise<boolean> => {
        if (!refreshToken) return false;

        if (!force) {
          const expiresAt = config?.tokenExpiresAt ? new Date(config.tokenExpiresAt) : null;
          const expiresAtMs = expiresAt instanceof Date ? expiresAt.valueOf() : Number.NaN;
          if (!Number.isNaN(expiresAtMs)) {
            const refreshAtMs = expiresAtMs - (proactiveRefreshThresholdSeconds * 1000);
            if (Date.now() < refreshAtMs) {
              return false;
            }
          } else {
            return false;
          }
        }

        const refreshed = await refreshXAccessToken({ refreshToken });
        const nextAccessToken = (refreshed.access_token as string) || accessToken;
        if (!nextAccessToken) {
          throw new Error('Missing X access token in refresh response');
        }
        accessToken = nextAccessToken;
        refreshToken = (refreshed.refresh_token as string) || refreshToken;
        tokenRefreshed = Boolean(refreshed.access_token) || tokenRefreshed;
        refreshMeta = {
          tokenType: (refreshed.token_type as string) || refreshMeta?.tokenType || null,
          expiresIn: (refreshed.expires_in as number) || refreshMeta?.expiresIn || null,
          scope: (refreshed.scope as string) || refreshMeta?.scope || null,
        };
        return Boolean(refreshed.access_token);
      };

      await tryRefreshToken({ force: false });

      if (followFromAuthenticatedUser && config.userId) {
        try {
          const followingUsers = await fetchXFollowing({
            apiBase,
            accessToken: accessToken!,
            userId: config.userId,
            maxResults: followingMaxUsers,
          });
          const whitelistSet = new Set(followingWhitelistUserIds.map(String));
          const filteredFollowing = whitelistSet.size > 0
            ? followingUsers.filter((user) => whitelistSet.has(String(user?.id || '')))
            : followingUsers;
          filteredFollowing.forEach((user) => {
            if (user?.id) resolvedUsers.push(user);
          });
        } catch (error) {
          const err = error as { response?: { status?: number } };
          const canRefresh = err?.response?.status === 401 && refreshToken;
          if (canRefresh) {
            try {
              await tryRefreshToken({ force: true });
              const followingUsers = await fetchXFollowing({
                apiBase,
                accessToken: accessToken!,
                userId: config.userId!,
                maxResults: followingMaxUsers,
              });
              const whitelistSet = new Set(followingWhitelistUserIds.map(String));
              const filteredFollowing = whitelistSet.size > 0
                ? followingUsers.filter((user) => whitelistSet.has(String(user?.id || '')))
                : followingUsers;
              filteredFollowing.forEach((user) => {
                if (user?.id) resolvedUsers.push(user);
              });
            } catch (refreshError) {
              const re = refreshError as { response?: { data?: unknown }; message?: string };
              console.warn('[xProvider] failed to fetch following list after token refresh:', re?.response?.data || re?.message || refreshError);
            }
          } else {
            const e = error as { response?: { data?: unknown }; message?: string };
            console.warn('[xProvider] failed to fetch following list:', e?.response?.data || e?.message || error);
          }
        }
      }

      const uniqueUsers = Array.from(
        resolvedUsers.reduce((map, user) => {
          if (!user?.id) return map;
          map.set(String(user.id), user);
          return map;
        }, new Map<string, XUser>()).values(),
      );

      if (!uniqueUsers.length) {
        throw new Error('Missing X userId/username');
      }

      const shouldUsePerUserSince = (
        followUserIds.length > 0
        || followUsernames.length > 0
        || followFromAuthenticatedUser
      );

      let tweetsByUser: Array<{ user: XUser; tweets: XTweet[] }>;
      try {
        tweetsByUser = await Promise.all(
          uniqueUsers.map(async (user) => {
            const userKey = String(user?.id || '').trim();
            const tweets = await fetchXTweets({
              apiBase,
              accessToken: accessToken!,
              userId: user.id,
              sinceId: shouldUsePerUserSince ? previousSinceByUser[userKey] : sinceId,
              maxResults: effectiveMaxResults,
              exclude,
            });
            return { user, tweets };
          }),
        );
      } catch (error) {
        const err = error as { response?: { status?: number } };
        if (err?.response?.status === 401 && refreshToken) {
          await tryRefreshToken({ force: true });
          tweetsByUser = await Promise.all(
            uniqueUsers.map(async (user) => {
              const userKey = String(user?.id || '').trim();
              const tweets = await fetchXTweets({
                apiBase,
                accessToken: accessToken!,
                userId: user.id,
                sinceId: shouldUsePerUserSince ? previousSinceByUser[userKey] : sinceId,
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
        .filter((message): message is NormalizedXPost => {
          if (!message) return false;
          if (!sinceDate || Number.isNaN(sinceDate.valueOf())) return true;
          const ts = new Date(message.timestamp);
          if (Number.isNaN(ts.valueOf())) return true;
          return ts > sinceDate;
        })
        .sort((a, b) => new Date(a.timestamp).valueOf() - new Date(b.timestamp).valueOf());

      const lastExternalIdsByUser: Record<string, string> = { ...previousSinceByUser };
      tweetsByUser.forEach(({ user, tweets }) => {
        const userKey = String(user?.id || '').trim();
        if (!userKey) return;
        const newestId = pickNewestTweetId(tweets);
        if (newestId) {
          lastExternalIdsByUser[userKey] = newestId;
        }
      });

      return {
        success: true,
        messageCount: messages.length,
        messages,
        content: messages.length ? `Fetched ${messages.length} post(s) from X` : 'No new posts',
        meta: {
          userId: uniqueUsers[0]?.id,
          username: uniqueUsers[0]?.username || sanitizedUsername,
          watchedUsers: uniqueUsers.length,
          watchedUserIds: uniqueUsers.map((user) => String(user?.id || '')).filter(Boolean),
          watchedViaFollowing: followFromAuthenticatedUser,
          lastExternalIdsByUser,
          tokenRefreshed,
          refreshedAccessToken: tokenRefreshed ? accessToken : undefined,
          refreshedRefreshToken: tokenRefreshed ? refreshToken : undefined,
          refreshedTokenType: refreshMeta?.tokenType || undefined,
          refreshedExpiresIn: refreshMeta?.expiresIn || undefined,
          refreshedScope: refreshMeta?.scope || undefined,
        },
      };
    },

    async health(): Promise<{ ok: boolean; error?: string; status?: number }> {
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
        const err = error as { response?: { status?: number; data?: { detail?: string; title?: string; error?: string } }; message?: string };
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail
          || err?.response?.data?.title
          || err?.response?.data?.error
          || err?.message
          || 'Failed to validate X credentials';
        return {
          ok: false,
          error: status ? `X API ${status}: ${detail}` : detail,
          status,
        };
      }
    },

    async publishPost({ text, hashtags = [], sourceUrl } = {}): Promise<{ success: boolean; provider: string; externalId: string | null; url: string | null; text: string }> {
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

      const id = (response?.data?.data?.id as string) || null;
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
