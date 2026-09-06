// This model suite uses the in-memory Mongo helper; keep its JWT dependency
// loadable on Node 26, as the other database-backed unit suites do.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');
const ChannelVerdict = require('../../../models/ChannelVerdict');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('ChannelVerdict', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await ChannelVerdict.syncIndexes();
  });
  afterAll(() => closeMongoDb());
  afterEach(() => clearMongoDb());

  const row = (overrides = {}) => ({
    integrationId: new mongoose.Types.ObjectId(),
    podId: new mongoose.Types.ObjectId(),
    provider: 'telegram',
    event: { kind: 'decision_request', podMessageId: '700' },
    verdict: 'interrupt',
    reason: 'card',
    at: new Date(),
    ...overrides,
  });

  it('keeps one connector receipt per workspace message and preserves the D7 read indexes', async () => {
    const first = row();
    await ChannelVerdict.create(first);
    await expect(ChannelVerdict.create({ ...first, reason: 'retry' }))
      .rejects.toMatchObject({ code: 11000 });

    const indexes = ChannelVerdict.schema.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      [{ integrationId: 1, at: -1 }, expect.any(Object)],
      [{ podId: 1, at: -1 }, expect.any(Object)],
      [{ 'event.podMessageId': 1 }, expect.any(Object)],
      [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
    ]));
  });

  it('accepts a lazily-linked decision id and a later channel receipt', async () => {
    const verdict = new ChannelVerdict(row({
      provider: 'slack',
      event: {
        kind: 'decision_request',
        podMessageId: '701',
        decisionId: new mongoose.Types.ObjectId(),
      },
      reachedHumanAt: new Date(),
      ruledVia: 'slack',
      expiresAt: new Date(Date.now() + (90 * 24 * 60 * 60 * 1000)),
    }));
    await expect(verdict.validate()).resolves.toBeUndefined();
  });
});
