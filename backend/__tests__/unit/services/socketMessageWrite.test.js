/**
 * TASK-503: with PostgreSQL configured, the socket send writes PG only. A PG
 * that is still booting or a failed insert is a retryable error, never a
 * MongoDB row (those rows carried no pgFallback flag and were never moved).
 */

jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../models/Message', () => jest.fn());

const PGMessage = require('../../../models/pg/Message');
const PGPod = require('../../../models/pg/Pod');
const { syncPodFromMongo } = require('../../../services/pgPodSyncService');
const MongoMessage = require('../../../models/Message');
const { writeSocketMessage, MESSAGE_STORE_UNAVAILABLE } = require('../../../services/socketMessageWrite');

// The refusal names the send so the client can drop its optimistic copy.
const REFUSED = {
  ok: false,
  error: {
    ...MESSAGE_STORE_UNAVAILABLE, podId: 'p1', content: 'hi', messageType: 'text',
  },
};

const input = (over = {}) => ({
  pgReady: true, podId: 'p1', userId: 'u1', content: 'hi', messageType: 'text', replyToMessageId: null, ...over,
});

describe('writeSocketMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    PGPod.findById.mockResolvedValue({ id: 'p1' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses while PG is still booting, without touching either store', async () => {
    const result = await writeSocketMessage(input({ pgReady: false }));

    expect(result).toEqual(REFUSED);
    expect(PGMessage.create).not.toHaveBeenCalled();
    expect(MongoMessage).not.toHaveBeenCalled();
  });

  it('returns a retryable error when the PG insert throws, writing nothing to MongoDB', async () => {
    PGMessage.create.mockRejectedValue(new Error('connection terminated'));

    const result = await writeSocketMessage(input());

    expect(result).toEqual(REFUSED);
    expect(MongoMessage).not.toHaveBeenCalled();
  });

  it('returns the joined row on success, passing the reply edge through', async () => {
    PGMessage.create.mockResolvedValue({ id: 7, content: 'hi' });
    PGMessage.findById.mockResolvedValue({ id: 7, content: 'hi', username: 'sam' });

    const result = await writeSocketMessage(input({ replyToMessageId: '5' }));

    expect(PGMessage.create).toHaveBeenCalledWith('p1', 'u1', 'hi', 'text', '5');
    expect(result).toEqual({ ok: true, message: { id: 7, content: 'hi', username: 'sam' } });
  });

  it('keeps an already-stored message when only the joined re-read fails', async () => {
    PGMessage.create.mockResolvedValue({ id: 8, content: 'hi' });
    PGMessage.findById.mockRejectedValue(new Error('read timeout'));

    const result = await writeSocketMessage(input());

    expect(result).toEqual({ ok: true, message: { id: 8, content: 'hi' } });
    expect(PGMessage.create).toHaveBeenCalledTimes(1);
  });

  it('heals a MongoDB-only pod into PG before the insert', async () => {
    PGPod.findById.mockResolvedValue(null);
    PGMessage.create.mockResolvedValue({ id: 9 });
    PGMessage.findById.mockResolvedValue({ id: 9 });

    await writeSocketMessage(input());

    expect(syncPodFromMongo).toHaveBeenCalledWith('p1', 'u1');
    expect(syncPodFromMongo.mock.invocationCallOrder[0])
      .toBeLessThan(PGMessage.create.mock.invocationCallOrder[0]);
  });
});
