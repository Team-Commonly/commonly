jest.mock('../../../repositories/agentPodReadCursorRepository', () => ({
  getReadWatermark: jest.fn(),
  advanceReadWatermark: jest.fn(),
}));
jest.mock('../../../models/Message', () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
  exists: jest.fn(),
}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const Cursor = require('../../../repositories/agentPodReadCursorRepository');
const Message = require('../../../models/Message');
const { pool } = require('../../../config/db-pg');
const Freshness = require('../../../services/agentSendFreshness');
const originalPgHost = process.env.PG_HOST;

describe('agent send-time freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PG_HOST;
    Message.exists.mockResolvedValue(null);
    Cursor.getReadWatermark.mockResolvedValue({ readAt: new Date('2026-10-24T00:00:00Z') });
  });
  afterAll(() => {
    if (originalPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = originalPgHost;
  });

  it('counts other authors since the read and previews no more than three', async () => {
    Message.countDocuments.mockResolvedValue(7);
    const rows = [1, 2, 3].map((id) => ({ _id: id, content: `message ${id}`, userId: { username: 'peer' }, createdAt: new Date() }));
    Message.find.mockReturnValue({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => rows }) }) }) });

    const hold = await Freshness.unseenMessages('agent-id', 'pod-id');
    expect(hold.unseenCount).toBe(7);
    expect(hold.messages).toHaveLength(3);
    expect(hold.message).toContain('There are 7 unseen messages.');
    expect(hold.message).toContain('continueAnyway:true');
    expect(Message.countDocuments).toHaveBeenCalledWith({
      podId: 'pod-id',
      $nor: [{ messageType: 'system', 'payload.kind': 'system-action' }],
      $and: [
        { $or: [{ userId: { $ne: 'agent-id' } }, { authorKind: 'kernel' }] },
        { $or: [
          { freshnessPending: true },
          { freshnessCommittedAt: { $gte: new Date('2026-10-24T00:00:00Z') } },
          {
            freshnessPending: { $exists: false },
            freshnessCommittedAt: { $exists: false },
            createdAt: { $gt: new Date('2026-10-24T00:00:00Z') },
          },
        ] },
      ],
    });
  });

  it('uses singular wording for one unseen message', async () => {
    Message.countDocuments.mockResolvedValue(1);
    Message.find.mockReturnValue({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) });

    const hold = await Freshness.unseenMessages('agent-id', 'pod-id');
    expect(hold.message).toContain('There is 1 unseen message.');
  });

  it('lets a quiet pod through and fails closed when the message store fails', async () => {
    Message.countDocuments.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('db down'));
    Message.find.mockReturnValue({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) });
    expect(await Freshness.unseenMessages('agent-id', 'pod-id')).toBeNull();
    await expect(Freshness.unseenMessages('agent-id', 'pod-id')).rejects.toThrow('db down');
  });

  it('uses a monotonic watermark for a successful read', async () => {
    const at = new Date('2026-10-24T01:00:00Z');
    Cursor.getReadWatermark.mockResolvedValueOnce(null);
    await Freshness.recordRead('agent-id', 'pod-id', { at }, []);
    expect(Cursor.advanceReadWatermark).toHaveBeenCalledWith('agent-id', 'pod-id', { readAt: at });
  });

  it('does not mistake an unavailable PostgreSQL store for a quiet pod', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockRejectedValue(new Error('pg down'));
    await expect(Freshness.unseenMessages('agent-id', 'pod-id')).rejects.toThrow('pg down');
    expect(Message.countDocuments).not.toHaveBeenCalled();
  });

  it('uses the PostgreSQL count and a bounded preview when PostgreSQL is configured', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockResolvedValue({ rows: [{
      id: 23, content: 'new plan', author: 'peer', created_at: new Date(), unseen_count: 8,
    }] });
    const hold = await Freshness.unseenMessages('agent-id', 'pod-id');
    expect(hold.unseenCount).toBe(8);
    expect(hold.messages).toEqual([expect.objectContaining({ id: '23', content: 'new plan' })]);
    expect(pool.query.mock.calls[0][0]).toContain('LIMIT 3');
    expect(pool.query.mock.calls[0][0]).toContain('freshness_revision >');
    expect(Message.countDocuments).not.toHaveBeenCalled();
  });

  it('bounds the PostgreSQL unseen query by the trigger id, and only a numeric id', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockResolvedValue({ rows: [] });
    await Freshness.unseenMessages('agent-id', 'pod-id', { seenThroughMessageId: '22' });
    expect(pool.query.mock.calls[0][1]).toEqual(['pod-id', -1, 'agent-id', 22]);
    expect(pool.query.mock.calls[0][0]).toContain('($4::integer IS NULL OR m.id > $4)');
    await Freshness.unseenMessages('agent-id', 'pod-id', { seenThroughMessageId: 'abc' });
    expect(pool.query.mock.calls[1][1][3]).toBeNull();
    await Freshness.unseenMessages('agent-id', 'pod-id');
    expect(pool.query.mock.calls[2][1][3]).toBeNull();
  });

  it('captures the PostgreSQL revision before the read and advances it with the cursor', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockResolvedValueOnce({ rows: [{ revision: '7' }] }).mockResolvedValueOnce({ rows: [] });
    const start = await Freshness.readStart('pod-id');
    expect(start).toEqual({ at: expect.any(Date), revision: 7 });
    expect(pool.query.mock.calls[0][0]).toContain('pod_message_revisions');
    Cursor.getReadWatermark.mockResolvedValueOnce(null);
    await Freshness.recordRead('agent-id', 'pod-id', start, []);
    expect(Cursor.advanceReadWatermark.mock.calls[0][2]).toEqual({ readAt: start.at, readRevision: 7 });
  });

  it('does not stamp a PostgreSQL read that omitted a newly committed message', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await Freshness.recordRead('agent-id', 'pod-id', { at: new Date(), revision: 12 }, ['19']);
    expect(pool.query.mock.calls[0][1][4]).toEqual([19]);
    expect(Cursor.advanceReadWatermark).not.toHaveBeenCalled();
  });

  it('stamps a PostgreSQL read when every new peer message was returned', async () => {
    process.env.PG_HOST = 'configured';
    Cursor.getReadWatermark.mockResolvedValueOnce({ readAt: new Date('2026-10-24T00:00:00Z'), readRevision: 4 });
    pool.query.mockResolvedValue({ rows: [] });
    await Freshness.recordRead('agent-id', 'pod-id', { at: new Date(), revision: 6 }, ['5', '6']);
    expect(pool.query.mock.calls[0][1]).toEqual(['pod-id', 4, 6, 'agent-id', [5, 6]]);
    expect(Cursor.advanceReadWatermark).toHaveBeenCalledTimes(1);
  });

  it('excludes system actions from both PostgreSQL send holds and omitted-read checks', async () => {
  jest.clearAllMocks();
  process.env.PG_HOST = 'configured';
  pool.query.mockResolvedValue({ rows: [] });
  await Freshness.unseenMessages('agent-id', 'pod-id');
  await Freshness.recordRead('agent-id', 'pod-id', { at: new Date(), revision: 10 }, []);
  expect(pool.query.mock.calls).toHaveLength(2);
  for (const [sql] of pool.query.mock.calls) {
    expect(sql).toContain("NOT (m.message_type = 'system' AND COALESCE(m.payload->>'kind', '') = 'system-action')");
    expect(sql.indexOf("= 'system-action'")).toBeLessThan(sql.indexOf('LIMIT'));
  }
});

});

describe('a delivered trigger is seen through its own message (TASK-015 inline reply)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PG_HOST;
    Cursor.getReadWatermark.mockResolvedValue({ readAt: new Date('2026-10-24T00:00:00Z') });
    Message.find.mockReturnValue({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) });
  });

  it('does not hold on the trigger itself: the query excludes it by id', async () => {
    Message.countDocuments.mockResolvedValue(0);
    const triggerId = '6adfeccc58eabb3645d76520';

    const hold = await Freshness.unseenMessages('agent-id', 'pod-id', { seenThroughMessageId: triggerId });
    expect(hold).toBeNull();
    expect(Message.countDocuments.mock.calls[0][0]._id).toEqual({ $gt: triggerId });
  });

  it('still holds on a message that landed after the trigger', async () => {
    Message.countDocuments.mockResolvedValue(1);
    const hold = await Freshness.unseenMessages('agent-id', 'pod-id', {
      seenThroughMessageId: '6adfeccc58eabb3645d76520',
    });
    expect(hold.unseenCount).toBe(1);
  });

  it('without a trigger the query has no id bound, so the old behaviour is unchanged', async () => {
    Message.countDocuments.mockResolvedValue(0);
    await Freshness.unseenMessages('agent-id', 'pod-id');
    expect(Message.countDocuments.mock.calls[0][0]).not.toHaveProperty('_id');
  });

  it('a non-ObjectId trigger is ignored rather than becoming an unbounded filter', async () => {
    Message.countDocuments.mockResolvedValue(0);
    await Freshness.unseenMessages('agent-id', 'pod-id', { seenThroughMessageId: { $ne: 1 } });
    expect(Message.countDocuments.mock.calls[0][0]).not.toHaveProperty('_id');
  });
});
