// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('../services/connectorSecrets');

/**
 * Discord webhook URL resolution — the ENCRYPTED REF is authoritative.
 *
 * The URL embeds the webhook's own token, so it is a bearer credential: posting
 * to it is posting AS that channel. It therefore lives as connector-secret
 * material (`services/connectorSecrets`, kind `discord-webhook-url`, declared in
 * `services/connectorSecretKinds`) and the row keeps only an opaque ref in
 * `config.webhookUrlRef` — the same shape Slack's bot token already had.
 *
 * Two plaintext stores are still declared and still read as FALLBACKS:
 * `platformIntegration.webhookUrl` and the legacy `config.webhookUrl`. Rows
 * connected before the encryption migration (`scripts/encrypt-discord-webhook-url`)
 * carry one; it unsets both, so on a migrated row only the ref exists.
 *
 * A ref that cannot be resolved THROWS rather than falling through to a
 * plaintext copy. The two are not equivalents: falling back would mean a row
 * whose secret was rotated or revoked keeps sending to a URL nothing manages —
 * and a wrong webhook URL authenticates as the wrong connector, silently. That
 * substitution is the defect this encryption exists to prevent (vera 74141).
 *
 * `hasDiscordWebhookUrl` is the presence test for call sites that only need to
 * know whether a webhook exists (it must not decrypt, and must not throw on an
 * unavailable key ring).
 */
export const resolveDiscordWebhookUrl = async (
  ref: unknown,
  ...legacy: unknown[]
): Promise<string | undefined> => {
  const trimmedRef = String(ref ?? '').trim();
  if (trimmedRef) {
    const material = await connectorSecrets.get(trimmedRef);
    const resolved = String(material ?? '').trim();
    if (!resolved) {
      // A decryptable-but-empty secret is a corrupt row, not an absent one.
      throw new Error(`Connector secret '${trimmedRef}' resolved to an empty value.`);
    }
    return resolved;
  }
  for (const candidate of legacy) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return undefined;
};

/** Presence of a webhook, without decrypting: the ref OR a legacy copy. */
export const hasDiscordWebhookUrl = (ref: unknown, ...legacy: unknown[]): boolean => (
  String(ref ?? '').trim().length > 0
  || legacy.some((candidate) => String(candidate ?? '').trim().length > 0)
);

export default resolveDiscordWebhookUrl;
