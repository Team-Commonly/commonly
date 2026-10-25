/**
 * The X and Instagram feed credentials, stored the way Slack's bot token and the
 * hosted-MCP pair are: the material lives in `services/connectorSecrets` and the
 * Integration row keeps only the refs `config.feedAccessTokenRef` /
 * `config.feedRefreshTokenRef` (kinds in `services/connectorSecretKinds`).
 *
 * Every writer goes through `storeFeedTokens` — the admin OAuth callback and save
 * forms (`routes/admin/globalIntegrations`), the generic connector create and
 * edit (`routes/integrations`), and the refresh write-back in
 * `services/externalFeedService`. Every reader goes through `readFeedAccessToken`
 * / `readFeedRefreshToken`: the providers and the admin following lookup.
 *
 * There is no read of a row's own `config.accessToken`. No writer sets it any
 * more, and a row still carrying one reads as having no credential, so it is
 * reconnected rather than served from the old field.
 */
// eslint-disable-next-line global-require
const connectorSecrets = require('./connectorSecrets');
// eslint-disable-next-line global-require
const {
  X_FEED_ACCESS_TOKEN,
  X_FEED_REFRESH_TOKEN,
  INSTAGRAM_FEED_ACCESS_TOKEN,
} = require('./connectorSecretKinds');

interface FeedTokens {
  accessToken?: unknown;
  refreshToken?: unknown;
}

interface FeedRefs {
  feedAccessTokenRef?: string;
  feedRefreshTokenRef?: string;
}

// Instagram issues no refresh token, so it has no refresh kind; a supplied one
// is dropped rather than kept on the row.
const FEED_KINDS: Record<string, { access: unknown; refresh?: unknown }> = {
  x: { access: X_FEED_ACCESS_TOKEN, refresh: X_FEED_REFRESH_TOKEN },
  instagram: { access: INSTAGRAM_FEED_ACCESS_TOKEN },
};

export const FEED_TOKEN_CONFIG_KEYS = ['accessToken', 'refreshToken'] as const;

export const isFeedType = (type: unknown): boolean => (
  Object.prototype.hasOwnProperty.call(FEED_KINDS, String(type || ''))
);

const material = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Split the token material out of a config a caller supplied. `rest` is safe to
 * write to the row; `tokens` goes to `storeFeedTokens`.
 */
export const takeFeedTokens = (
  config: Record<string, unknown>,
): { rest: Record<string, unknown>; tokens: FeedTokens } => {
  const rest = { ...config };
  const tokens: FeedTokens = {};
  FEED_TOKEN_CONFIG_KEYS.forEach((key) => {
    if (key in rest) {
      tokens[key] = rest[key];
      delete rest[key];
    }
  });
  return { rest, tokens };
};

/**
 * Encrypt the supplied tokens under the row's id and return the ref fields to
 * set on its config. A blank token writes nothing, so a caller that supplies only
 * an access token keeps the refresh ref already on the row. The store upserts on
 * `(integrationId, kind)`, so a rotation returns the same ref it replaces.
 */
export const storeFeedTokens = async (
  integrationId: string,
  type: string,
  tokens: FeedTokens,
): Promise<FeedRefs> => {
  const kinds = FEED_KINDS[type];
  if (!kinds) return {};
  const refs: FeedRefs = {};
  const accessToken = material(tokens.accessToken);
  if (accessToken) {
    refs.feedAccessTokenRef = await connectorSecrets.put(integrationId, kinds.access, accessToken);
  }
  const refreshToken = material(tokens.refreshToken);
  if (refreshToken && kinds.refresh) {
    refs.feedRefreshTokenRef = await connectorSecrets.put(integrationId, kinds.refresh, refreshToken);
  }
  return refs;
};

const readRef = async (ref: unknown): Promise<string | undefined> => {
  const value = String(ref || '').trim();
  if (!value) return undefined;
  return connectorSecrets.get(value);
};

export const readFeedAccessToken = (config: FeedRefs | null | undefined): Promise<string | undefined> => (
  readRef(config?.feedAccessTokenRef)
);

export const readFeedRefreshToken = (config: FeedRefs | null | undefined): Promise<string | undefined> => (
  readRef(config?.feedRefreshTokenRef)
);

/**
 * The config as the completeness predicate reads it. The manifests keep naming
 * `accessToken` as what a caller supplies (`integrations/catalog` publishes it),
 * while the row holds its ref, so a stored ref counts as the token being present
 * — the same mapping `routes/integrations` makes for Discord's env-supplied
 * `botToken`. A presence check only; the ref is never used as a credential.
 */
export const withFeedTokenPresence = <T extends Record<string, unknown>>(config: T): T => ({
  ...config,
  // Only the ref counts: a row's own `accessToken` is not read by any provider.
  accessToken: config?.feedAccessTokenRef ? String(config.feedAccessTokenRef) : undefined,
});

/**
 * Whether the row holds a usable access token: its ref resolves. A ref whose
 * secret is gone (an inactive row's secret is swept) answers false, so a save
 * form that leaves the token field blank asks for one instead of keeping a ref
 * no reader can resolve.
 */
export const hasFeedAccessToken = async (config: FeedRefs | null | undefined): Promise<boolean> => {
  try {
    return Boolean(await readFeedAccessToken(config));
  } catch {
    return false;
  }
};

module.exports = {
  FEED_TOKEN_CONFIG_KEYS,
  isFeedType,
  takeFeedTokens,
  storeFeedTokens,
  readFeedAccessToken,
  readFeedRefreshToken,
  hasFeedAccessToken,
  withFeedTokenPresence,
};
