// @ts-nocheck

// Offerability: a provider is offered when this instance holds the credentials
// (readiness) AND a builtin active Installable row carries it (the roster).
//
// Why this file exists at all, and why it uses the real store and the real
// manifests: every other test of the catalogue injects fake stores
// (`installableCatalogService.test.js` mocks `Installable.find`), so
// "readiness declared, no row seeded" was UNREPRESENTABLE in the suite. That is
// the exact state that shipped a lowercase `discord` row whose Add ended in 404
// installable_not_found (Vera 71152, Wren 71162). A mocked store can only test
// the catalogue's arithmetic; it cannot test whether the roster agrees with it.
//
// @kais 71169 ruling: `catalogFor` keeps one entry per readiness-declaring
// manifest (nothing vanishes) and reports `offered`; `availableProviders` and
// the row action both read it.

jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const Installable = require('../../../models/Installable');
const { catalogFor, providerOffered } = require('../../../services/installable/installableCatalogService');
const { TELEGRAM_CONNECTOR } = require('../../../scripts/seed-builtin-connectors');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const USER_ID = new mongoose.Types.ObjectId().toString();

const channelsOf = async (userId = USER_ID) => {
  const { installables } = await catalogFor(userId);
  return installables.filter((entry) => entry.list === 'channels');
};

const byId = (entries) => new Map(entries.map((entry) => [entry.installableId, entry]));

describe('provider offerability', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => { await clearMongoDb(); });

  it('reports one channel entry per readiness-declaring manifest, offered or not', async () => {
    // The invariant that keeps Discord from VANISHING, which is the failure mode
    // on the other side of this defect: an entry is dropped when a provider has
    // readiness and no row, so the page stops being able to say anything about it.
    const { manifests } = require('../../../integrations/manifests');
    const declared = Object.values(manifests)
      .filter((manifest) => typeof manifest.readiness === 'function')
      .map((manifest) => manifest.id)
      .sort();

    const entries = await channelsOf();

    expect(entries.map((entry) => entry.installableId).sort()).toEqual(declared);
    expect(new Set(entries.map((entry) => entry.installableId)).size).toBe(entries.length);
  });

  it('never labels a row with its own raw id', async () => {
    // The visible half of the bug: `label: installable?.name || installableId`
    // drew a lowercase `discord` on a page whose every other row is a word.
    const entries = await channelsOf();

    entries.forEach((entry) => {
      expect(entry.label).not.toBe(entry.installableId);
      expect(entry.label).toBeTruthy();
    });
    expect(byId(entries).get('discord').label).toBe(manifestsLabel('discord'));
  });

  it('offers a provider once a builtin active row exists, and not before', async () => {
    const before = byId(await channelsOf());
    expect(before.get('telegram').offered).toBe(false);
    expect(await providerOffered('telegram')).toBe(false);

    await Installable.create({ ...TELEGRAM_CONNECTOR });

    const after = byId(await channelsOf());
    expect(after.get('telegram').offered).toBe(true);
    expect(await providerOffered('telegram')).toBe(true);
    // Offering one provider must not offer its neighbours: a predicate that
    // answered from the wrong field would flip every row at once.
    expect(after.get('slack').offered).toBe(false);
    expect(after.get('discord').offered).toBe(false);
  });

  it('does not count a row that is not builtin and active', async () => {
    // The predicate is a join, not a presence check. A marketplace row, or a
    // retired builtin one, must not make a provider installable: `install()`
    // resolves the same way and would still answer installable_not_found.
    await Installable.create({ ...TELEGRAM_CONNECTOR, source: 'marketplace' });
    expect(await providerOffered('telegram')).toBe(false);

    await Installable.deleteMany({});
    await Installable.create({ ...TELEGRAM_CONNECTOR, status: 'deprecated' });
    expect(await providerOffered('telegram')).toBe(false);
  });

  it('keeps capability and offerability independent', async () => {
    // Offered without configured is a real state (a seeded row on an instance
    // with no keys) and so is configured without offered (Discord before this
    // PR). The page needs both bits to pick the right of three state lines;
    // collapsing them is what produced a single wrong answer.
    const original = process.env.DISCORD_BOT_TOKEN;
    await Installable.create({ ...TELEGRAM_CONNECTOR });

    const sealed = byId(await channelsOf());
    expect(sealed.get('telegram').offered).toBe(true);
    expect(sealed.get('discord').offered).toBe(false);
    expect(sealed.get('discord').available).toBe(false);

    process.env.DISCORD_BOT_TOKEN = 'configured';
    process.env.DISCORD_CLIENT_ID = 'configured';
    process.env.DISCORD_CLIENT_SECRET = 'configured';
    try {
      const configured = byId(await channelsOf());
      expect(configured.get('discord').available).toBe(true);
      expect(configured.get('discord').offered).toBe(false);
    } finally {
      delete process.env.DISCORD_CLIENT_ID;
      delete process.env.DISCORD_CLIENT_SECRET;
      if (original === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = original;
    }
  });
});

function manifestsLabel(id) {
  // eslint-disable-next-line global-require
  const { manifests } = require('../../../integrations/manifests');
  return manifests[id].catalog.label;
}
