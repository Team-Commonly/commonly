/**
 * The GroupMe and Slack token copies a generic connector write could leave on a
 * row (TASK-539, from the #2719 review).
 *
 * GroupMe: an agent reading a group's history calls the GroupMe API with a
 * member's access token (`routes/agentsRuntime` integration messages). It is
 * stored the way the X / Instagram feed pair is: the material goes to
 * `services/connectorSecrets` and the row keeps only `config.accessTokenRef`.
 * GroupMe issues no refresh token, so a supplied one is dropped.
 *
 * Slack: the bot token is written by the OAuth bind as `config.botTokenRef`
 * (`routes/installables`), and nothing reads a row's own `accessToken` or
 * `refreshToken`. A supplied copy is dropped, not stored.
 *
 * There is no read of a row's own `config.accessToken`. A row still carrying
 * one reads as having no credential until `scripts/migrate-chat-token-copies`
 * moves it.
 */
// eslint-disable-next-line global-require
const connectorSecrets = require('./connectorSecrets');
// eslint-disable-next-line global-require
const { GROUPME_ACCESS_TOKEN } = require('./connectorSecretKinds');

export const CHAT_TOKEN_CONFIG_KEYS = ['accessToken', 'refreshToken'] as const;

const CHAT_TOKEN_TYPES = ['groupme', 'slack'];

export const isChatTokenType = (type: unknown): boolean => CHAT_TOKEN_TYPES.includes(String(type || ''));

/**
 * Split the token keys out of a config a caller supplied. `rest` is safe to
 * write to the row. `accessToken` is the GroupMe material to store, and is
 * absent for Slack, whose copy has no reader.
 */
export const takeChatTokens = (
  type: unknown,
  config: Record<string, unknown>,
): { rest: Record<string, unknown>; accessToken?: unknown } => {
  const rest = { ...config };
  const { accessToken } = rest;
  CHAT_TOKEN_CONFIG_KEYS.forEach((key) => { delete rest[key]; });
  return String(type) === 'groupme' ? { rest, accessToken } : { rest };
};

/**
 * Encrypt a GroupMe access token under the row's id and return the ref field to
 * set on its config. A blank token writes nothing, so a save that leaves the
 * field empty keeps the ref already on the row.
 */
export const storeGroupmeAccessToken = async (
  integrationId: string,
  accessToken: unknown,
): Promise<{ accessTokenRef?: string }> => {
  const material = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!material) return {};
  return { accessTokenRef: await connectorSecrets.put(integrationId, GROUPME_ACCESS_TOKEN, material) };
};

export const readGroupmeAccessToken = async (
  config: { accessTokenRef?: unknown } | null | undefined,
): Promise<string | undefined> => {
  const ref = String(config?.accessTokenRef || '').trim();
  if (!ref) return undefined;
  return connectorSecrets.get(ref);
};

module.exports = {
  CHAT_TOKEN_CONFIG_KEYS,
  isChatTokenType,
  takeChatTokens,
  storeGroupmeAccessToken,
  readGroupmeAccessToken,
};
