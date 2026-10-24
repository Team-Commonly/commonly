jest.mock('../../../models/AgentPodReadCursor', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../../../models/Message', () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
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
    expect(hold.message).toContain('continueAnyway:true');
    expect(Message.countDocuments).toHaveBeenCalledWith({
      podId: 'pod-id',
      createdAt: { $gt: new Date('2026-10-24T00:00:00Z') },
      $or: [{ userId: { $ne: 'agent-id' } }, { authorKind: 'kernel' }],
    });
  });

  it('lets a quiet pod through and fails closed when the message store fails', async () => {
    Message.countDocuments.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('db down'));
    Message.find.mockReturnValue({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) });
    expect(await Freshness.unseenMessages('agent-id', 'pod-id')).toBeNull();
    await expect(Freshness.unseenMessages('agent-id', 'pod-id')).rejects.toThrow('db down');
  });

  it('uses a monotonic watermark for a successful read', async () => {
    const at = new Date('2026-10-24T01:00:00Z');
    await Freshness.recordRead('agent-id', 'pod-id', at);
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
});
