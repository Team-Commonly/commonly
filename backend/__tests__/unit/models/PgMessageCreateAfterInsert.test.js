// TASK-313: once the INSERT has committed, a failure in the pod touch or the
// attention bookkeeping must not reject create(). The controller's Mongo
// fallback would otherwise write a second copy of a message that is already
// in Postgres.
jest.mock('../../../config/db-pg', () => ({
  pool: {
    query: jest.fn(),
  },
}));

const mockRecordMentionedUsers = jest.fn();
const mockResolveMentionAttentionForReply = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  recordMentionedUsers: (...args) => mockRecordMentionedUsers(...args),
  resolveMentionAttentionForReply: (...args) => mockResolveMentionAttentionForReply(...args),
  resolve: jest.fn(),
  resolveMany: jest.fn(),
}));

const { pool } = require('../../../config/db-pg');
const Message = require('../../../models/pg/Message');

const insertedRow = {
  id: '7',
  pod_id: 'p',
  user_id: 'u',
  content: 'hello',
  message_type: 'text',
  created_at: new Date('2026-10-23T00:00:00Z'),
  thread_root_id: null,
  reply_to_message_id: null,
};

describe('PG Message create after the insert has committed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordMentionedUsers.mockResolvedValue(undefined);
    mockResolveMentionAttentionForReply.mockResolvedValue(0);
  });

  it('resolves with the inserted row when the pod touch fails', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [insertedRow] })
      .mockRejectedValueOnce(new Error('pod update failed'));

    const row = await Message.create('p', 'u', 'hello', 'text', null, null, null);

    expect(row.id).toBe('7');
    expect(mockRecordMentionedUsers).toHaveBeenCalledTimes(1);
  });

  it('resolves with the inserted row when attention bookkeeping fails', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [insertedRow] })
      .mockResolvedValueOnce({ rows: [] });
    mockRecordMentionedUsers.mockRejectedValueOnce(new Error('attention write failed'));

    const row = await Message.create('p', 'u', 'hello', 'text', null, null, null);

    expect(row.id).toBe('7');
  });

  it('still throws before the insert when the reply target is not in the pod', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(Message.create('p', 'u', 'hello', 'text', '99', null, null))
      .rejects.toThrow(/not in this pod|reply_target_unavailable|ThreadRoot/i);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
