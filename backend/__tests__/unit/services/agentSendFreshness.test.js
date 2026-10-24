jest.mock('../../../models/AgentPodReadCursor', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../../models/Message', () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
  exists: jest.fn(),
}));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));

const Cursor = require('../../../models/AgentPodReadCursor');
const Message = require('../../../models/Message');
const { pool } = require('../../../config/db-pg');
const Freshness = require('../../../services/agentSendFreshness');
const originalPgHost = process.env.PG_HOST;

describe('agent send-time freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PG_HOST;
    Message.exists.mockResolvedValue(null);
    Cursor.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ readAt: new Date('2026-10-24T00:00:00Z') }) }) });
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
    Cursor.findOne.mockReturnValueOnce({ select: () => ({ lean: async () => null }) });
    await Freshness.recordRead('agent-id', 'pod-id', { at }, []);
    expect(Cursor.updateOne).toHaveBeenCalledWith(
      { _id: 'agent-id:pod-id' },
      { $max: { readAt: at }, $setOnInsert: { agentUserId: 'agent-id', podId: 'pod-id' } },
      { upsert: true },
    );
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

  it('captures the PostgreSQL revision before the read and advances it with the cursor', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockResolvedValueOnce({ rows: [{ revision: '7' }] }).mockResolvedValueOnce({ rows: [] });
    const start = await Freshness.readStart('pod-id');
    expect(start).toEqual({ at: expect.any(Date), revision: 7 });
    expect(pool.query.mock.calls[0][0]).toContain('pod_message_revisions');
    Cursor.findOne.mockReturnValueOnce({ select: () => ({ lean: async () => null }) });
    await Freshness.recordRead('agent-id', 'pod-id', start, []);
    expect(Cursor.updateOne.mock.calls[0][1].$max).toEqual({ readAt: start.at, readRevision: 7 });
  });

  it('does not stamp a PostgreSQL read that omitted a newly committed message', async () => {
    process.env.PG_HOST = 'configured';
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await Freshness.recordRead('agent-id', 'pod-id', { at: new Date(), revision: 12 }, ['19']);
    expect(pool.query.mock.calls[0][1][4]).toEqual([19]);
    expect(Cursor.updateOne).not.toHaveBeenCalled();
  });

  it('stamps a PostgreSQL read when every new peer message was returned', async () => {
    process.env.PG_HOST = 'configured';
    Cursor.findOne.mockReturnValueOnce({
      select: () => ({ lean: async () => ({ readAt: new Date('2026-10-24T00:00:00Z'), readRevision: 4 }) }),
    });
    pool.query.mockResolvedValue({ rows: [] });
    await Freshness.recordRead('agent-id', 'pod-id', { at: new Date(), revision: 6 }, ['5', '6']);
    expect(pool.query.mock.calls[0][1]).toEqual(['pod-id', 4, 6, 'agent-id', [5, 6]]);
    expect(Cursor.updateOne).toHaveBeenCalledTimes(1);
  });
});
