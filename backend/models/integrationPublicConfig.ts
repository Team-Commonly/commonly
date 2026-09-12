/**
 * The one list of Integration config keys that never leave the server.
 *
 * Bearer credentials (bot tokens, signing secrets, OAuth access and refresh
 * tokens, webhook URLs that embed their secret) and the references that point
 * at one (a ConnectorSecret ref, a browser-bound OAuth nonce). The providers
 * read all of them off the document; no browser needs any of them, and until
 * #1673 the X and Instagram edit forms prefilled accessToken from the pod list
 * because it happened to be there. `connectCode` is deliberately NOT here: it
 * is the one-time enable code a member pastes into Telegram, and ChatRoom and
 * the Connectors page read it from the pod list.
 *
 * Every JSON path an Integration takes out of the server runs through
 * toPublicIntegrationConfig: the model's toJSON, and the lean catalog read in
 * installableCatalogService that bypasses toJSON. Add a key here, not at the
 * call sites.
 */
export const INTEGRATION_SECRET_CONFIG_KEYS = [
  'botToken',
  'signingSecret',
  'secretToken',
  'accessToken',
  'refreshToken',
  'webhookUrl',
  'botTokenRef',
  'oauthStateNonce',
] as const;

export const toPublicIntegrationConfig = (
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined => {
  if (!config || typeof config !== 'object') return config;
  INTEGRATION_SECRET_CONFIG_KEYS.forEach((key) => { delete config[key]; });
  const pending = config.pendingBind;
  if (pending && typeof pending === 'object') {
    delete (pending as Record<string, unknown>).botTokenRef;
  }
  const adminPause = config.adminPause;
  if (adminPause && typeof adminPause === 'object') {
    const { reason, at } = adminPause as { reason?: unknown; at?: unknown };
    config.adminPause = { reason, at };
  }
  return config;
};

// CJS compat: let require() return the named exports directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports;
