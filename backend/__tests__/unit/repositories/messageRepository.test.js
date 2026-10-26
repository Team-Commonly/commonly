/**
 * TASK-503: the one pod-message read. PG answers when it can; the MongoDB
 * fallback lives only here and returns the PG row shape, oldest first.
 */
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));
jest.mock('../../../models/Message', () => ({ find: jest.fn() }));

const PGMessage = require('../../../models/pg/Message');
const MongoMessage = require('../../../models/Message');
const { listPodMessages, toPodMessage } = require('../../../repositories/messageRepository');

const mongoChain = (docs) => {
  const calls = {};
  const chain = {
    populate: (...args) => { calls.populate = args; return chain; },
    sort: (arg) => { calls.sort = arg; return chain; },
    limit: (arg) => { calls.limit = arg; return chain; },
    lean: async () => docs,
  };
  MongoMessage.find.mockImplementation((query) => { calls.query = query; return chain; });
  return calls;
};

describe('listPodMessages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => console.warn.mockRestore());

  it('returns the PG rows as they are and never reads MongoDB', async () => {
    const rows = [{ id: '1' }, { id: '2' }];
    PGMessage.findByPodId.mockResolvedValue(rows);
    await expect(listPodMessages('p1', { limit: 20, before: '2026-10-01T00:00:00.000Z' })).resolves.toBe(rows);
    expect(PGMessage.findByPodId).toHaveBeenCalledWith('p1', 20, '2026-10-01T00:00:00.000Z');
    expect(MongoMessage.find).not.toHaveBeenCalled();
  });

  it('clamps the limit to 1..200 for both stores', async () => {
    PGMessage.findByPodId.mockResolvedValue([]);
    await listPodMessages('p1', { limit: 5000 });
    expect(PGMessage.findByPodId).toHaveBeenLastCalledWith('p1', 200, null);

    PGMessage.findByPodId.mockRejectedValue(new Error('pg down'));
    const calls = mongoChain([]);
    await listPodMessages('p1', { limit: 5000 });
    expect(calls.limit).toBe(200);
  });

  it('on a PG failure reads MongoDB, newest page first, and returns it oldest first', async () => {
    PGMessage.findByPodId.mockRejectedValue(new Error('pg down'));
    const calls = mongoChain([
      { _id: 'm2', podId: 'p1', userId: 'u2', content: 'second', createdAt: new Date('2026-01-02') },
      { _id: 'm1', podId: 'p1', userId: 'u1', content: 'first', createdAt: new Date('2026-01-01') },
    ]);
    const rows = await listPodMessages('p1', { limit: 2, before: '2026-02-01T00:00:00.000Z' });
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(calls.query).toEqual({ podId: 'p1', createdAt: { $lt: new Date('2026-02-01T00:00:00.000Z') } });
    expect(calls.sort).toEqual({ createdAt: -1 });
    expect(calls.populate).toEqual(['userId', 'username profilePicture isBot']);
  });
});

describe('toPodMessage', () => {
  it('maps a populated MongoDB message onto the PG row shape', () => {
    const at = new Date('2026-01-01');
    const row = toPodMessage({
      _id: 'm1',
      podId: 'p1',
      userId: { _id: 'u1', username: 'sam', profilePicture: 'pic', isBot: false },
      content: 'hi',
      messageType: 'text',
      authorKind: 'kernel',
      payload: { kind: 'card' },
      createdAt: at,
      updatedAt: at,
    });
    expect(row).toEqual({
      id: 'm1',
      _id: 'm1',
      pgId: '',
      pod_id: 'p1',
      user_id: 'u1',
      content: 'hi',
      text: 'hi',
      message_type: 'text',
      messageType: 'text',
      author_kind: 'kernel',
      payload: { kind: 'card' },
      created_at: at,
      createdAt: at,
      updated_at: at,
      username: 'sam',
      profile_picture: 'pic',
      is_bot: false,
      userId: { _id: 'u1', username: 'sam', profilePicture: 'pic', isBot: false },
      replyTo: null,
    });
  });

  it('keeps an unpopulated author as a plain id, and an unknown bot flag absent', () => {
    const row = toPodMessage({ _id: 'm1', podId: 'p1', userId: 'u1', content: 'hi' });
    expect(row.userId).toBe('u1');
    expect(row.user_id).toBe('u1');
    expect(row).not.toHaveProperty('is_bot');
    expect(row.message_type).toBe('text');
    expect(row.author_kind).toBeNull();
  });
});
