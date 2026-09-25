#!/usr/bin/env node
/*
 * Encrypt the per-row Discord webhook URLs at rest (TASK-124 part 2).
 *
 * `discord_integrations.webhookUrl` is a bearer credential: the URL embeds the
 * webhook's own token, so anyone holding it can post into the channel as that
 * webhook. It was the last connector credential stored in plaintext outside the
 * ESO path — the Slack bot token has lived in `connector_secrets` (AES-256-GCM,
 * key ring from `CONNECTOR_SECRET_KEYS` / `CONNECTOR_SECRET_ACTIVE_KEY`) since the
 * Slack bind landed. Part 2 routes every writer through that envelope and stores
 * only the ref, at `Integration.config.webhookUrlRef`, and every reader through
 * `utils/discordWebhookUrl`.
 *
 * This script is the data half. It runs AFTER the deploy that reads through the
 * resolver (the old image read the plaintext field directly, so clearing first
 * would break it), and it is idempotent: a second run finds no plaintext left.
 *
 * The destructive half is the `$unset`, and the only thing that keeps it safe is
 * its ORDER: per row, the `put` completes before either plaintext is cleared. So
 * a failure of any kind — an unusable key ring, a transient write error — leaves
 * that row's plaintext exactly where it was, and a re-run both retries it and
 * reports what already moved as `alreadyEncrypted`. There is deliberately no
 * separate ring pre-flight: `listWithUnavailableKey` lists refs whose key is
 * missing from the ring, it cannot fail, and a call that cannot fail is not a
 * guard. The ordering is, and two witnesses in the suite hold it there.
 *
 * Both plaintext stores are read, because a row connected before this change can
 * hold either: the platform document's `webhookUrl` (the writer that derived it
 * from the Discord API) and the legacy `Integration.config.webhookUrl` (which a
 * caller's body could set with an empty string, and which the merged effective
 * config surfaced). A non-empty value in either is a candidate; the run unsets
 * both and writes one encrypted ref.
 *
 * Two reported counts are deliberately NOT actions:
 *
 *   - `unexpectedFormat`: a value that is not a `discord.com/api/webhooks/` URL.
 *     It is still encrypted — the point of the migration is to stop the value
 *     being readable at rest, not to judge it, and encrypting preserves whatever
 *     the row was already doing.
 *   - `alreadyEncrypted`: a row that carries a ref and no plaintext, i.e. one
 *     already migrated (or written after the deploy). A second run should report
 *     all rows here and `migrated=0`.
 *
 * The default is a dry run that logs each distinct URL as a digest, never the URL
 * itself. Run with `--apply` to write. Needs MONGO_URI and the connector-secret
 * key ring in the environment; run it inside the backend pod, where both live.
 */

/* eslint-disable no-console */
const crypto = require('crypto');
const mongoose = require('mongoose');

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('../services/connectorSecrets');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { DISCORD_WEBHOOK_URL } = require('../services/connectorSecretKinds');

const DISCORD_COLLECTION = 'discord_integrations';
const INTEGRATION_COLLECTION = 'integrations';

export interface DiscordWebhookUrlEncryptResult {
  /** Discord integration rows examined. */
  rows: number;
  /** Rows holding a non-empty plaintext URL in either store. */
  candidates: number;
  /** Rows whose plaintext was replaced by an encrypted ref (0 on a dry run). */
  migrated: number;
  /** Rows already carrying a ref and no plaintext. */
  alreadyEncrypted: number;
  /** Rows with neither a ref nor a plaintext URL — nothing to encrypt. */
  withoutWebhook: number;
  /** Candidates whose value is not a `discord.com/api/webhooks/` URL; encrypted anyway, reported. */
  unexpectedFormat: number;
  /** Candidates whose plaintext came from `Integration.config.webhookUrl` rather than the platform document. */
  configCopies: number;
  /** One digest per candidate: identifies a URL without reproducing it. */
  digests: string[];
}

const describeUrl = (url: string): string => {
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  return `${digest} (${url.length} chars)`;
};

export async function encryptDiscordWebhookUrls(
  { apply = false }: { apply?: boolean } = {},
): Promise<DiscordWebhookUrlEncryptResult> {
  const discord = mongoose.connection.collection(DISCORD_COLLECTION);
  const integrations = mongoose.connection.collection(INTEGRATION_COLLECTION);
  const rows = await discord
    .find({}, { projection: { _id: 1, integrationId: 1, webhookUrl: 1 } })
    .toArray();

  let candidates = 0;
  let migrated = 0;
  let alreadyEncrypted = 0;
  let withoutWebhook = 0;
  let unexpectedFormat = 0;
  let configCopies = 0;
  const digests: string[] = [];

  for (const row of rows) {
    const integration = await integrations.findOne(
      { _id: row.integrationId },
      { projection: { config: 1 } },
    );
    const storedPlaintext = String(row.webhookUrl || '').trim();
    const configPlaintext = String(integration?.config?.webhookUrl || '').trim();
    const existingRef = String(integration?.config?.webhookUrlRef || '').trim();

    if (!storedPlaintext && !configPlaintext) {
      if (existingRef) alreadyEncrypted += 1;
      else withoutWebhook += 1;
      continue;
    }

    const url = storedPlaintext || configPlaintext;
    candidates += 1;
    if (!storedPlaintext) configCopies += 1;
    if (!url.includes('discord.com/api/webhooks/')) unexpectedFormat += 1;
    digests.push(describeUrl(url));

    if (!apply) continue;

    // Order matters, and it is the whole of the protection: a `put` that throws
    // leaves this row's plaintext in both stores for the next attempt. Never move
    // an `$unset` above this line.
    const webhookUrlRef = await connectorSecrets.put(
      String(row.integrationId),
      DISCORD_WEBHOOK_URL,
      url,
    );
    await integrations.updateOne(
      { _id: row.integrationId },
      {
        $set: { 'config.webhookUrlRef': webhookUrlRef },
        $unset: { 'config.webhookUrl': '' },
      },
    );
    await discord.updateOne({ _id: row._id }, { $unset: { webhookUrl: '' } });
    migrated += 1;
  }

  return {
    rows: rows.length,
    candidates,
    migrated,
    alreadyEncrypted,
    withoutWebhook,
    unexpectedFormat,
    configCopies,
    digests,
  };
}

/**
 * The operator-facing report, returned as lines rather than printed inline so the
 * wording is witnessable — the same reason the token-clear script exports its own
 * (`backend/__tests__/unit/scripts/clearDiscordBotToken.test.ts`).
 */
export const formatReport = (
  result: DiscordWebhookUrlEncryptResult,
  apply: boolean,
): string[] => {
  const lines = [
    `[encrypt-discord-webhook-url] ${apply ? 'APPLY' : 'DRY-RUN'} `
    + `rows=${result.rows} candidates=${result.candidates} migrated=${result.migrated}`,
    ...result.digests.map((digest) => `  plaintext webhook ${digest}`),
    '[encrypt-discord-webhook-url] already encrypted (ref, no plaintext): '
    + `${result.alreadyEncrypted}`,
    '[encrypt-discord-webhook-url] no webhook at all: '
    + `${result.withoutWebhook}`,
    '[encrypt-discord-webhook-url] plaintext found in Integration.config.webhookUrl '
    + `(the legacy second store): ${result.configCopies}`,
    '[encrypt-discord-webhook-url] candidates not matching the Discord webhook URL shape '
    + `(encrypted anyway): ${result.unexpectedFormat}`,
  ];
  if (!apply) lines.push('DRY RUN — nothing written. Re-run with --apply.');
  return lines;
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  try {
    const result = await encryptDiscordWebhookUrls({ apply });
    formatReport(result, apply).forEach((line) => console.log(line));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
