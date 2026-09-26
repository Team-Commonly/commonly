/**
 * Every kind of encrypted connector credential, in one place.
 *
 * A secret's identity is the PAIR `(integrationId, kind)`: one connector row can
 * hold more than one kind (a Slack connector keeps its bot token, a Discord
 * connector its webhook URL), and each kind's ref lives at a different place on
 * the owning row. Four sites encode that pair, and all four read THIS module —
 * which is the point, because three of them fail in ways that do not raise:
 *
 *   1. `models/ConnectorSecret` — the compound unique index. Leave a
 *      single-field `integrationId` index beside it and boot's `syncIndexes()`
 *      keeps the old one, so the second kind is rejected by an index whose name
 *      no longer describes it.
 *   2. `services/connectorSecrets` — the upsert filter *and* the 11000 retry's
 *      filter. Filtered on `integrationId` alone, the second `put` does not
 *      collide: it matches the first kind's row and `$set`s the new ciphertext
 *      onto it, so the first ref stays valid and starts decrypting to the second
 *      secret. A missing secret is loud; a substituted one is not (Vera 74141).
 *   3. `installableReconciler.sweepOrphanedConnectorSecrets` — its keep-condition
 *      is `refPaths`. With a literal `botTokenRef` there, a Discord secret is
 *      revoked ten minutes after it is written (`ORPHAN_SECRET_GRACE_MS`),
 *      which is the defect this module exists for (Vera 74130).
 *   4. `installableReconciler.sweepUnavailableConnectorSecretKeys` — the message
 *      it marks the row with is `unavailableReason`, so a Discord owner is not
 *      told a Slack secret is unavailable (Vera 74131).
 *
 * Adding a kind means adding a spec here and nothing else.
 */

export interface ConnectorSecretKindSpec {
  /** Stored on the secret row; the discriminator of the compound key. */
  kind: string;
  /** Stored on the secret row; the `Integration.type` that owns this kind. */
  provider: string;
  /**
   * Dotted paths on the owning `Integration` row that hold this kind's ref.
   * Read by the orphan sweep's keep-condition, so EVERY path a writer can set
   * must be named here — a path this list omits is a secret the sweep deletes.
   */
  refPaths: readonly string[];
  /** The sentence written for the person reading the Connectors page. */
  unavailableReason: string;
}

/** The Slack bot token: the ref lives on the row the OAuth bind writes. */
export const SLACK_BOT_TOKEN: ConnectorSecretKindSpec = {
  kind: 'slack-bot-token',
  provider: 'slack',
  refPaths: ['config.botTokenRef', 'config.pendingBind.botTokenRef'],
  unavailableReason: 'Slack connector secret key is unavailable',
};

/**
 * The Discord channel webhook URL. It is a bearer credential on its own — the
 * URL embeds the token that authorises posting to the channel — so it is stored
 * the same way and read through `utils/discordWebhookUrl`.
 */
export const DISCORD_WEBHOOK_URL: ConnectorSecretKindSpec = {
  kind: 'discord-webhook-url',
  provider: 'discord',
  refPaths: ['config.webhookUrlRef'],
  unavailableReason: 'Discord connector webhook is unavailable',
};

export const CONNECTOR_SECRET_KINDS: readonly ConnectorSecretKindSpec[] = [
  SLACK_BOT_TOKEN,
  DISCORD_WEBHOOK_URL,
];

export const kindSpec = (kind: string): ConnectorSecretKindSpec | undefined => (
  CONNECTOR_SECRET_KINDS.find((spec) => spec.kind === kind)
);

/** Every ref path the sweeps must inspect, across all kinds. */
export const allRefPaths = (): string[] => CONNECTOR_SECRET_KINDS.flatMap((spec) => [...spec.refPaths]);

const valueAtPath = (row: unknown, path: string): unknown => path
  .split('.')
  .reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  ), row);

/**
 * Does this row still reference `ref` through one of `spec`'s paths?
 *
 * An unknown kind answers `false` for every path, which is why the caller must
 * decide what to do with it rather than treating this as "unreferenced".
 */
export const rowReferencesSecret = (
  row: unknown,
  spec: ConnectorSecretKindSpec,
  ref: string,
): boolean => spec.refPaths.some((path) => String(valueAtPath(row, path) ?? '') === ref);
