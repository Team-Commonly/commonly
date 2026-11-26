/**
 * One decision per acting card: two first clicks on the same card must land
 * on one row. Decision-card rows never carry cardMessageId and stay free to
 * share a messageId.
 */
const DecisionRequest = require('../../../models/DecisionRequest');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');

const row = (overrides = {}) => ({
  podId: '64b000000000000000000001', agentUserId: '64b000000000000000000002', agentName: 'release-agent',
  decisionClass: 'implementation', title: 'Ship it?', question: 'Ship it?',
  options: [{ label: 'Ship' }, { label: 'Hold' }], messageId: '700', ...overrides,
});

describe('DecisionRequest cardMessageId', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await DecisionRequest.syncIndexes();
  });
  afterAll(closeMongoDb);
  afterEach(() => DecisionRequest.deleteMany({}));

  test('a second row for the same card is refused', async () => {
    await DecisionRequest.create(row({ cardMessageId: '700' }));
    await expect(DecisionRequest.create(row({ cardMessageId: '700' }))).rejects.toMatchObject({ code: 11000 });
  });

  test('two concurrent first-click upserts leave one row', async () => {
    const upsert = () => DecisionRequest.findOneAndUpdate(
      { cardMessageId: '701' }, { $setOnInsert: row({ messageId: '701' }) }, { upsert: true, new: true },
    ).catch((error) => { if (error.code !== 11000) throw error; });
    await Promise.all([upsert(), upsert(), upsert()]);
    expect(await DecisionRequest.countDocuments({ cardMessageId: '701' })).toBe(1);
  });

  test('rows without the key may share a messageId', async () => {
    await DecisionRequest.create(row());
    await expect(DecisionRequest.create(row())).resolves.toBeTruthy();
  });
});
