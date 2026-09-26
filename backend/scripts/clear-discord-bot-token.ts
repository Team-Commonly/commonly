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
 * would break those paths on the old image. Sequence: merge -> deploy -> this
 * script.
 *
 * The acceptance for that deploy is the test tier (the resolver's own unit test
 * pins the precedence; four of the seven call sites pin the call) plus one named
 * future event: the next real Discord connect takes the create path #1889
 * changed, and its row will not carry a copy. It is deliberately NOT the
 * agent-runtime messages route. That route returns 403 first (pod match, then the
 * `integration:messages:read` scope) and otherwise 404 from a `findOne` requiring
 * `config.agentAccessEnabled: true`, which no live row sets — all of it ABOVE the
 * resolver, so the route reads identically on both revisions and discriminates
 * nothing. Measured 2026-09-25 after it was proposed as the instrument; the rule
 * this earned is review-checklist rule 36.
 *
 * Scope is deliberately narrow. It touches `discord_integrations.botToken` only.
 * `Integration.config.botToken` is a different store, in a different collection,
 * that holds no secret: measured live 2026-09-25, its two discord rows carry the
 * KEY with an empty value, which is the shape the retired write path left:
 * `DiscordCallback.tsx` still posts `botToken: ''` in the request, but the API
 * strips it before the row is saved (TASK-139), so nothing has written this key
 * to a row since. The resolver still consults it as
 * a fallback, so this script reports on it — secrets and empty keys counted
 * apart, because `$exists` answers the wrong question — and never writes it
 * unless `--unset-empty` is passed.
 *
 * `--unset-empty` removes that key from a row that holds no value, which is the
 * only residue of the retired write path: no writer can put it back (TASK-139
 * strips it from a body), so the key sits on those rows forever, and an
 * `$exists` census reads "2 rows carry `config.botToken`" for a field with no
 * writer — the reading that produced a wrong claim on 2026-09-25. Removing it
 * changes no reader: `''` and absent are equivalent at every one (`isSupplied`,
 * the env-first discord resolver, `slackProvider`), and no code tests the key's
 * presence (TASK-141).
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

/**
 * A delivered copy is a non-empty string. Absent, `null` and `''` are not
 * copies, in either store — one definition, used for the write predicate and
 * for the count of the other store, so the two cannot drift apart again.
 */
const NON_EMPTY_STRING = { $type: 'string', $ne: '' };
const STORED_COPY = { botToken: NON_EMPTY_STRING };

/**
 * The `--unset-empty` target, scoped by `type` so it cannot reach another
 * connector's row: an empty copy of the retired Discord token field.
 */
const EMPTY_CONFIG_HOLDER = { type: 'discord', 'config.botToken': '' };

export interface DiscordBotTokenClearResult {
  /** Documents holding a non-empty stored copy. */
  candidates: number;
  /** Documents the field was removed from (0 on a dry run). */
  cleared: number;
  /** One digest per candidate: identifies a copy without reproducing it. */
  digests: string[];
  /** `Integration.config.botToken` holding a non-empty string — a secret at rest, reported, never written. */
  integrationConfigCopies: number;
  /**
   * `Integration.config.botToken` present as a KEY with no value.
   * Historical rows only: the live Discord bind used to write exactly this shape
   * (`botToken: ''`, `DiscordCallback.tsx`), so it was the normal state of that
   * store and not a finding — which is why it is reported apart from the secrets
   * above. Since `botToken` joined `SERVER_OWNED_CONFIG_KEYS`
   * (`routes/integrations.ts`) the write path strips the key instead, so this
   * count should stop growing while the rows already carrying it stay counted.
   */
  integrationConfigEmptyHolders: number;
  /** Empty holders `--unset-empty` removed the key from (0 on a dry run). */
  integrationConfigEmptyCleared: number;
}

const describeCopy = (token: string): string => {
  const digest = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  return `${digest} (${token.length} chars)`;
};

export async function clearDiscordBotTokenCopies(
  { apply = false, unsetEmpty = false }: { apply?: boolean; unsetEmpty?: boolean } = {},
): Promise<DiscordBotTokenClearResult> {
  const collection = mongoose.connection.collection(DISCORD_COLLECTION);
  const rows = await collection
    .find(STORED_COPY, { projection: { _id: 1, botToken: 1 } })
    .toArray();
  const digests = rows.map((row: { botToken: string }) => describeCopy(row.botToken));

  // The other store. Never written by any writer, and still the resolver's
  // fallback, so these counts are a report rather than a target: a non-zero
  // SECRET count means some row's authority is a config field, which is worth
  // knowing before the env token is the only source anyone has.
  //
  // Reported as two numbers because `$exists` is a KEY test, not a value test,
  // and one `$exists` count answers the wrong question here. Measured on the
  // production store 2026-09-25: a single `$exists` count read **2** on a run
  // whose prediction was 0, both row values being `''` — the shape the retired
  // write path left — so an empty key looked like an unaccounted credential and
  // stopped a correct run. Secrets and empty keys are counted apart.
  const integrationCollection = mongoose.connection.collection(INTEGRATION_COLLECTION);
  const integrationConfigCopies = await integrationCollection.countDocuments({
    type: 'discord', 'config.botToken': NON_EMPTY_STRING,
  });
  const integrationConfigKeys = await integrationCollection.countDocuments({
    type: 'discord', 'config.botToken': { $exists: true },
  });
  const integrationConfigEmptyHolders = Math.max(
    0,
    integrationConfigKeys - integrationConfigCopies,
  );

  if (!apply) {
    return {
      candidates: rows.length,
      cleared: 0,
      digests,
      integrationConfigCopies,
      integrationConfigEmptyHolders,
      integrationConfigEmptyCleared: 0,
    };
  }

  const result = await collection.updateMany(STORED_COPY, { $unset: { botToken: '' } });
  // Reported apart from the count above so a run shows both the pre-state and
  // the write it made: the counts are read before this step on purpose.
  const emptyClear = unsetEmpty
    ? await integrationCollection.updateMany(EMPTY_CONFIG_HOLDER, { $unset: { 'config.botToken': '' } })
    : { modifiedCount: 0 };
  return {
    candidates: rows.length,
    cleared: result.modifiedCount,
    digests,
    integrationConfigCopies,
    integrationConfigEmptyHolders,
    integrationConfigEmptyCleared: emptyClear.modifiedCount,
  };
}

/**
 * The operator-facing report, returned as lines rather than printed inline so the
 * wording itself is witnessable: the misleading line here — a single count of
 * `Integration.config.botToken` "holders", answered by `$exists` — is what made a
 * correct run look anomalous on 2026-09-25 and stopped an `--apply` that was
 * about to be right.
 */
export const formatReport = (
  result: DiscordBotTokenClearResult,
  apply: boolean,
  unsetEmpty = false,
): string[] => {
  const lines = [
    `[clear-discord-bot-token] ${apply ? 'APPLY' : 'DRY-RUN'} `
    + `candidates=${result.candidates} cleared=${result.cleared}`,
    ...result.digests.map((copy) => `  stored copy ${copy}`),
    '[clear-discord-bot-token] Integration.config.botToken secrets at rest '
    + `(reported, never written): ${result.integrationConfigCopies}`,
    '[clear-discord-bot-token] Integration.config.botToken empty holders '
    + `(a key with no value; stripped before save, so nothing writes it): ${result.integrationConfigEmptyHolders}`,
  ];
  if (unsetEmpty) {
    lines.push('[clear-discord-bot-token] --unset-empty '
      + (apply
        ? `removed the key from ${result.integrationConfigEmptyCleared} empty holder(s)`
        : `would remove the key from ${result.integrationConfigEmptyHolders} empty holder(s)`));
  }
  if (!apply) lines.push('DRY RUN — nothing written. Re-run with --apply.');
  return lines;
};

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const unsetEmpty = process.argv.includes('--unset-empty');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  try {
    const result = await clearDiscordBotTokenCopies({ apply, unsetEmpty });
    formatReport(result, apply, unsetEmpty).forEach((line) => console.log(line));
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
