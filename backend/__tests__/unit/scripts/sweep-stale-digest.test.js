const mongoose = require('mongoose');
const AgentEvent = require('../../../models/AgentEvent');
const { sweepStaleDigest, parseArgs, SWEEP_REASON } = require('../../../scripts/sweep-stale-digest');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-10-26T12:00:00.000Z');
const POD_ID = new mongoose.Types.ObjectId();

describe('sweep-stale-digest', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterEach(async () => { await clearMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });

  // Raw insert, so each row keeps the createdAt it is given.
  const row = (overrides) => ({
    agentName: 'rhea',
    instanceId: 'default',
    podId: POD_ID,
    type: 'message.posted',
    deliveryMode: 'digest',
    status: 'pending',
    attempts: 0,
    payload: { content: 'ambient' },
    ...overrides,
  });
  const seed = async () => {
    const ago = (hours) => new Date(NOW.getTime() - hours * HOUR_MS);
    const docs = [
      row({ createdAt: ago(30) }),
      row({ createdAt: ago(25) }),
      row({ createdAt: ago(48), status: 'delivered', deliveryNonce: 'n-1' }),
      row({ createdAt: ago(26), agentName: 'quire' }),
      row({ createdAt: ago(2) }), // inside the day: stays unread
      row({ createdAt: ago(30), deliveryMode: 'wake', type: 'chat.mention' }), // a task, never swept
      row({ createdAt: ago(30), status: 'acked' }), // already read
    ];
    const { insertedIds } = await AgentEvent.collection.insertMany(docs);
    return Object.values(insertedIds);
  };
  const statuses = async (ids) => Promise.all(ids.map(async (id) => (await AgentEvent.findById(id).lean()).status));

  test('a dry run reports per seat and changes nothing', async () => {
    const ids = await seed();
    const result = await sweepStaleDigest({ now: NOW });
    expect(result).toEqual({
      apply: false,
      cutoff: '2026-10-25T12:00:00.000Z',
      matched: 4,
      settled: 0,
      seats: [
        { agentName: 'rhea', instanceId: 'default', count: 3 },
        { agentName: 'quire', instanceId: 'default', count: 1 },
      ],
    });
    expect(await statuses(ids)).toEqual(['pending', 'pending', 'delivered', 'pending', 'pending', 'pending', 'acked']);
  });

  test('apply settles only digest rows older than a day, with the sweep as their reason', async () => {
    const ids = await seed();
    const result = await sweepStaleDigest({ apply: true, now: NOW });
    expect(result.matched).toBe(4);
    expect(result.settled).toBe(4);
    expect(await statuses(ids)).toEqual(['acked', 'acked', 'acked', 'acked', 'pending', 'pending', 'acked']);
    const swept = await AgentEvent.findById(ids[2]).lean();
    expect(swept.deliveryNonce).toBeNull();
    expect(swept.delivery).toEqual(expect.objectContaining({ outcome: 'no_action', reason: SWEEP_REASON }));
    expect((await AgentEvent.findById(ids[6]).lean()).delivery).toBeUndefined();
  });

  test('a second apply finds nothing left', async () => {
    await seed();
    await sweepStaleDigest({ apply: true, now: NOW });
    expect(await sweepStaleDigest({ apply: true, now: NOW }))
      .toEqual(expect.objectContaining({ matched: 0, settled: 0, seats: [] }));
  });

  test('--dry-run wins over --apply, and no flag is a dry run', () => {
    expect(parseArgs([])).toEqual({ apply: false });
    expect(parseArgs(['--dry-run'])).toEqual({ apply: false });
    expect(parseArgs(['--apply'])).toEqual({ apply: true });
    expect(parseArgs(['--apply', '--dry-run'])).toEqual({ apply: false });
  });
});
