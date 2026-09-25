// @ts-nocheck

// The migration suite needs testUtils' Mongo harness, not JWT behavior.
jest.mock('jsonwebtoken', () => ({}));

import mongoose from 'mongoose';

const {
  clearDiscordBotTokenCopies,
  formatReport,
} = require('../../../scripts/clear-discord-bot-token');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const COPY_A = `revoked-copy-a-${'a'.repeat(55)}`;
const COPY_B = `revoked-copy-b-${'b'.repeat(55)}`;
const COPY_C = `revoked-copy-c-${'c'.repeat(55)}`;

const discordRows = () => mongoose.connection.collection('discord_integrations');
const integrationRows = () => mongoose.connection.collection('integrations');

const seedDiscordRow = (overrides = {}) => ({
  integrationId: new mongoose.Types.ObjectId(),
  serverId: 'srv',
  serverName: 'Server',
  channelId: 'chan',
  channelName: 'channel',
  webhookUrl: 'https://discord.com/api/webhooks/1/token',
  webhookId: 'wh1',
  ...overrides,
});

/**
 * Three rows carrying a stored copy, plus the three shapes that are NOT copies.
 * Returns the ids, because "the field is gone" has to be asserted on the rows
 * that had one — a query for "no copy left" also passes on a blanking update.
 */
const seedStoredCopies = async () => {
  const copies = [COPY_A, COPY_B, COPY_C].map((botToken) => seedDiscordRow({ botToken }));
  const nulled = seedDiscordRow({ botToken: null });
  const blanked = seedDiscordRow({ botToken: '' });
  const absent = seedDiscordRow();
  await discordRows().insertMany([...copies, nulled, blanked, absent]);
  return {
    copyIds: copies.map((row) => row._id),
    nullId: nulled._id,
    emptyId: blanked._id,
  };
};

describe('clear-discord-bot-token', () => {
  beforeAll(async () => setupMongoDb());
  afterAll(async () => closeMongoDb());
  beforeEach(async () => clearMongoDb());

  it('counts only non-empty copies as candidates', async () => {
    await seedStoredCopies();

    const result = await clearDiscordBotTokenCopies({ apply: false });

    // Six rows, three copies: null / '' / absent are not copies of a credential.
    expect(await discordRows().countDocuments()).toBe(6);
    expect(result.candidates).toBe(3);
    expect(result.digests).toHaveLength(3);
  });

  it('writes nothing without --apply', async () => {
    await seedStoredCopies();

    const result = await clearDiscordBotTokenCopies({ apply: false });

    expect(result.cleared).toBe(0);
    expect(await discordRows().countDocuments({ botToken: COPY_A })).toBe(1);
    expect(await discordRows().countDocuments({ botToken: COPY_B })).toBe(1);
    expect(await discordRows().countDocuments({ botToken: COPY_C })).toBe(1);
  });

  it('removes the field rather than blanking it', async () => {
    const { copyIds, nullId, emptyId } = await seedStoredCopies();

    const result = await clearDiscordBotTokenCopies({ apply: true });

    expect(result.candidates).toBe(3);
    expect(result.cleared).toBe(3);
    // Per-row: `$set: { botToken: '' }` satisfies every "no copy left" query
    // while leaving a field behind, and the empty string is exactly what the
    // dead controller path used to write.
    const cleared = await discordRows().find({ _id: { $in: copyIds } }).toArray();
    expect(cleared).toHaveLength(3);
    cleared.forEach((row) => {
      expect(Object.prototype.hasOwnProperty.call(row, 'botToken')).toBe(false);
    });
    expect(await discordRows().countDocuments()).toBe(6);
    // The rows that never held a copy are out of scope and stay as they were.
    // Asserted by `_id`: `{ botToken: null }` also matches an ABSENT field, so a
    // count query could not tell the untouched row from the cleared ones.
    const nulled = await discordRows().findOne({ _id: nullId });
    const blanked = await discordRows().findOne({ _id: emptyId });
    expect(nulled.botToken).toBeNull();
    expect(blanked.botToken).toBe('');
  });

  it('is idempotent', async () => {
    await seedStoredCopies();
    await clearDiscordBotTokenCopies({ apply: true });

    const second = await clearDiscordBotTokenCopies({ apply: true });

    expect(second.candidates).toBe(0);
    expect(second.cleared).toBe(0);
    expect(second.digests).toEqual([]);
  });

  it('reports the other store as secrets and empty keys apart, and never writes it', async () => {
    await seedStoredCopies();
    // The live shapes, measured on the production store 2026-09-25: one row
    // holding a secret, one carrying the KEY with an empty value — which is what
    // the live bind used to write (`DiscordCallback.tsx` posted `botToken: ''`;
    // the write path now strips the key, so this is the historical population) —
    // and one without the key at all. A single `$exists` count reported the empty
    // key as a holder (it read 2 on a run whose prediction was 0) and turned a
    // normal state into an unaccounted credential.
    await integrationRows().insertMany([
      { type: 'discord', scope: 'user', config: { botToken: COPY_A, chatId: 'c1' } },
      { type: 'discord', scope: 'user', config: { botToken: '', chatId: 'c2' } },
      { type: 'discord', scope: 'user', config: { chatId: 'c3' } },
    ]);

    const dry = await clearDiscordBotTokenCopies({ apply: false });
    const applied = await clearDiscordBotTokenCopies({ apply: true });

    expect(dry.integrationConfigCopies).toBe(1);
    expect(dry.integrationConfigEmptyHolders).toBe(1);
    expect(applied.integrationConfigCopies).toBe(1);
    expect(applied.integrationConfigEmptyHolders).toBe(1);
    // Integration.config is the resolver's fallback read, not a copy this step
    // owns: both shapes must survive the clear, including the empty key.
    expect(await integrationRows().countDocuments({ 'config.botToken': COPY_A })).toBe(1);
    expect(await integrationRows().countDocuments({ 'config.botToken': '' })).toBe(1);
  });

  it('prints the other store as two labelled lines, not one count', () => {
    const lines = formatReport({
      candidates: 3,
      cleared: 0,
      digests: ['f8cbe9180815 (72 chars)'],
      integrationConfigCopies: 0,
      integrationConfigEmptyHolders: 2,
    }, false);

    // The line that misled the operator on 2026-09-25 said "holders", was answered
    // by `$exists`, and printed 2 for two empty keys. Secrets and keys are now two
    // lines with different nouns, and the empty-key line says why it can be normal.
    expect(lines).toContain(
      '[clear-discord-bot-token] Integration.config.botToken secrets at rest '
      + '(reported, never written): 0',
    );
    expect(lines).toContain(
      '[clear-discord-bot-token] Integration.config.botToken empty holders '
      + "(a key with no value; the live bind writes ''): 2",
    );
    expect(lines.filter((line) => line.includes('holders'))).toHaveLength(1);
    expect(lines[0]).toBe('[clear-discord-bot-token] DRY-RUN candidates=3 cleared=0');
    expect(lines[1]).toBe('  stored copy f8cbe9180815 (72 chars)');
    expect(lines).toContain('DRY RUN — nothing written. Re-run with --apply.');
    expect(formatReport({
      candidates: 3,
      cleared: 3,
      digests: [],
      integrationConfigCopies: 0,
      integrationConfigEmptyHolders: 0,
    }, true)).not.toContain('DRY RUN — nothing written. Re-run with --apply.');
  });

  it('identifies each copy without reproducing it', async () => {
    await seedStoredCopies();

    const result = await clearDiscordBotTokenCopies({ apply: false });

    result.digests.forEach((entry) => {
      expect(entry).toMatch(/^[0-9a-f]{12} \(\d+ chars\)$/);
    });
    const logged = result.digests.join(' ');
    [COPY_A, COPY_B, COPY_C].forEach((token) => {
      expect(logged).not.toContain(token);
    });
    // Distinct copies must not collapse to one line in the log.
    expect(new Set(result.digests).size).toBe(3);
  });
});
