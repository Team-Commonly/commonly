/**
 * The one list of Integration fields that never leave the server.
 *
 * Bearer credentials (bot tokens, signing secrets, OAuth access and refresh
 * tokens, webhook URLs that embed their secret) and the references that point
 * at one (a ConnectorSecret ref, a browser-bound OAuth nonce, the claim ids
 * that fence an install or an OAuth bind, and the stored hash of every ingest
 * token). The providers read all of them off the document; no browser needs
 * any of them, and until #1673 the X and Instagram edit forms prefilled
 * accessToken from the pod list because it happened to be there.
 * `connectCode` is deliberately NOT here: it is the one-time enable code a
 * member pastes into Telegram, and ChatRoom and the Connectors page read it
 * from the pod list and the owner's list. Surfaces with no reader drop it
 * through withoutConnectCode instead: the admin list, and a Slack row in the
 * catalog, where the code is the OAuth state. Ingest tokens are listed without
 * their hash by GET /api/integrations/:id/ingest-tokens.
 *
 * Every JSON path an Integration takes out of the server runs through
 * toPublicIntegration: the model's toJSON, and the lean catalog read in
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
  'oauthStateClaimId',
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

export const toPublicIntegration = (
  integration: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined => {
  if (!integration || typeof integration !== 'object') return integration;
  delete integration.installationClaimId;
  if (Array.isArray(integration.ingestTokens)) {
    integration.ingestTokens = integration.ingestTokens.map((token) => {
      if (!token || typeof token !== 'object') return token;
      const { tokenHash: _omit, ...rest } = token as Record<string, unknown>;
      return rest;
    });
  }
  toPublicIntegrationConfig(integration.config as Record<string, unknown> | null | undefined);
  return integration;
};

// For an already-public Integration on a surface that has no reader for the
// connect code: drops the code and its expiry together.
export const withoutConnectCode = (
  integration: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined => {
  const config = integration?.config;
  if (config && typeof config === 'object') {
    delete (config as Record<string, unknown>).connectCode;
    delete (config as Record<string, unknown>).connectCodeExpiresAt;
  }
  return integration;
};

// CJS compat: let require() return the named exports directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports;
