#!/usr/bin/env node
/*
 * Clear the stored Discord bot-token copies that TASK-124 step 1 stopped reading.
 *
 * `discord_integrations.botToken` was a per-row copy of a credential the server
 * already owns in `process.env.DISCORD_BOT_TOKEN`. `POST /api/integrations` wrote
 * it on connect, and it outlived every rotation of the env token: by the time
 * anyone looked, all three live rows carried a 72-char token Discord had already
 * revoked (401 against `GET /users/@me`, measured read-only from inside the
 * backend pod). Step 1 (#1889, merged as cce68b58) routed every read through
 * `resolveDiscordBotToken()` — env first, the stored copy only as a fallback —
 * and stopped the write. This script is the data half: the copies are now
 * unreachable, so remove them rather than leave a revoked credential at rest for
 * a future code path to pick up.
 *
 * Ordering matters, and it is the reason this is a separate step: the pre-#1889
 * build still READ the stored copy on two paths (`discordService.ts` fetchMessages
 * and getChannels, with no env fallback). Clearing before that build is replaced
 * would break those paths on the old image. Sequence: merge -> deploy ->
 * acceptance read (`GET /api/agents/runtime/pods/:podId/integrations/:integrationId/messages`
 * returns 200 where it 400s today) -> this script.
 *
 * Scope is deliberately narrow. It touches `discord_integrations.botToken` only.
 * `Integration.config.botToken` is a different store, in a different collection,
 * that was never written (measured live: absent on all three discord rows); the
 * resolver still consults it as a fallback, so this script reports on it and
 * never writes it.
 *
 * Idempotent: a second run finds nothing to clear. Run with `--apply` to write;
 * the default is a dry run that logs each distinct copy as a digest, never the
 * token itself.
 */

/* eslint-disable no-console */
const crypto = require('crypto');
const mongoose = require('mongoose');

const DISCORD_COLLECTION = 'discord_integrations';
const INTEGRATION_COLLECTION = 'integrations';

/** A stored copy is a non-empty string. Absent, null and '' are not copies. */
const STORED_COPY = { botToken: { $type: 'string', $ne: '' } };

export interface DiscordBotTokenClearResult {
  /** Documents holding a non-empty stored copy. */
  candidates: number;
  /** Documents the field was removed from (0 on a dry run). */
  cleared: number;
  /** One digest per candidate: identifies a copy without reproducing it. */
  digests: string[];
  /** `Integration.config.botToken` holders — reported, never written. */
  integrationConfigCopies: number;
}

const describeCopy = (token: string): string => {
  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  return `${digest} (${token.length} chars)`;
};

export async function clearDiscordBotTokenCopies(
  { apply = false }: { apply?: boolean } = {},
): Promise<DiscordBotTokenClearResult> {
  const collection = mongoose.connection.collection(DISCORD_COLLECTION);
  const rows = await collection
    .find(STORED_COPY, { projection: { _id: 1, botToken: 1 } })
    .toArray();
  const digests = rows.map((row: { botToken: string }) => describeCopy(row.botToken));

  // The other store. Never written by any writer, and still the resolver's
  // fallback, so this count is a report rather than a target: a non-zero value
  // means some row's authority is a config field, which is worth knowing before
  // the env token is the only source anyone has.
  const integrationConfigCopies = await mongoose.connection
    .collection(INTEGRATION_COLLECTION)
    .countDocuments({ type: 'discord', 'config.botToken': { $exists: true } });

  if (!apply) {
    return {
      candidates: rows.length,
      cleared: 0,
      digests,
      integrationConfigCopies,
    };
  }

  const result = await collection.updateMany(STORED_COPY, { $unset: { botToken: '' } });
  return {
    candidates: rows.length,
    cleared: result.modifiedCount,
    digests,
    integrationConfigCopies,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  try {
    const result = await clearDiscordBotTokenCopies({ apply });
    console.log(
      `[clear-discord-bot-token] ${apply ? 'APPLY' : 'DRY-RUN'} `
      + `candidates=${result.candidates} cleared=${result.cleared}`,
    );
    result.digests.forEach((copy) => console.log(`  stored copy ${copy}`));
    console.log(
      '[clear-discord-bot-token] Integration.config.botToken holders '
      + `(reported, never written): ${result.integrationConfigCopies}`,
    );
    if (!apply) console.log('DRY RUN — nothing written. Re-run with --apply.');
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
