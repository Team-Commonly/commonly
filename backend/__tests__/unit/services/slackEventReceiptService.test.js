const SlackEventReceipt = require('../../../models/SlackEventReceipt');
const { claim, markDone, EVENT_CLAIM_TTL_MS } = require('../../../services/slackEventReceiptService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('SlackEventReceipt claim lifecycle', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await SlackEventReceipt.syncIndexes();
  });
  afterAll(() => closeMongoDb());
  beforeEach(() => clearMongoDb());

  test('marks a completed event done so a retry cannot relay it again', async () => {
    expect(await claim('Ev1', 'T1')).toBe('claimed');
    await markDone('Ev1');
    expect(await claim('Ev1', 'T1')).toBe('duplicate_done');
  });

  test('takes over an abandoned processing claim with one CAS winner', async () => {
    const old = new Date(Date.now() - EVENT_CLAIM_TTL_MS - 1);
    await SlackEventReceipt.create({ eventId: 'Ev-stale', teamId: 'T1', state: 'processing', claimedAt: old, receivedAt: old });

    const outcomes = await Promise.all([
      claim('Ev-stale', 'T1'),
      claim('Ev-stale', 'T1'),
    ]);

    expect(outcomes.filter((outcome) => outcome === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate_processing')).toHaveLength(1);
  });
});
