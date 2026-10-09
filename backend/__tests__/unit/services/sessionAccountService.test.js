// TASK-133 (d): the one live-row read behind every user-session verifier.
//
// These witnesses use the real model against the in-memory Mongo on purpose.
// The defect this service closes is a projection: a verifier that reads
// `.select('banned')` and then asks about `isBot` reads `undefined` and refuses
// nothing — a guard that cannot see what it guards. A mock that ignores its
// `select` argument would pass either way, so the bot case below is only
// meaningful against a real row.
const User = require('../../../models/User');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');
const {
  loadSessionAccount,
  sessionRefusal,
} = require('../../../services/sessionAccountService');

describe('sessionAccountService', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  let seq = 0;
  const row = (overrides = {}) => {
    seq += 1;
    return User.create({
      username: `session-account-${seq}`,
      email: `session-account-${seq}@example.com`,
      password: 'hashed-pass',
      ...overrides,
    });
  };

  it('passes a human row', async () => {
    const user = await row();

    expect(sessionRefusal(await loadSessionAccount(String(user._id)))).toBeNull();
  });

  it('refuses an agent row — the term the projection has to carry', async () => {
    const user = await row({ isBot: true });

    // `.select('banned')` alone would return no `isBot` here and this reads null.
    expect(sessionRefusal(await loadSessionAccount(String(user._id)))).toBe('bot');
  });

  it('refuses a banned row', async () => {
    const user = await row({ banned: true });

    expect(sessionRefusal(await loadSessionAccount(String(user._id)))).toBe('banned');
  });

  it('refuses a row that no longer exists', async () => {
    expect(sessionRefusal(await loadSessionAccount('6a8f6dc7a1dccf2e02f31015'))).toBe('missing');
  });

  it('keeps the vocabulary deterministic when a row is both', async () => {
    const user = await row({ isBot: true, banned: true });

    expect(sessionRefusal(await loadSessionAccount(String(user._id)))).toBe('banned');
  });
});
