/**
 * TASK-503: with PostgreSQL configured, the socket send writes PG only. A PG
 * that is still booting or a failed insert is a retryable error, never a
 * MongoDB row (those rows carried no pgFallback flag and were never moved).
 */

jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../models/Message', () => jest.fn());

const fs = require('fs');
const path = require('path');
const PGMessage = require('../../../models/pg/Message');
const PGPod = require('../../../models/pg/Pod');
const { syncPodFromMongo } = require('../../../services/pgPodSyncService');
const MongoMessage = require('../../../models/Message');
const {
  writeSocketMessage, refuseSocketMessageType, MESSAGE_STORE_UNAVAILABLE, MESSAGE_TYPE_NOT_ALLOWED,
  MESSAGE_SEND_FAILED_EVENT,
} = require('../../../services/socketMessageWrite');

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

describe('the refused-send event name', () => {
  // The server names the event in one constant; the legacy ChatRoom listens
  // for it by literal. A rename on either side would drop every refusal
  // silently, so pin the two together.
  it('is the event ChatRoom subscribes to and unsubscribes from', () => {
    const chatRoomPath = path.resolve(__dirname, '../../../../frontend/src/components/ChatRoom.tsx');
    const chatRoom = fs.readFileSync(chatRoomPath, 'utf8');

    expect(chatRoom).toContain(`socket.on('${MESSAGE_SEND_FAILED_EVENT}', handleSendFailed)`);
    expect(chatRoom).toContain(`socket.off('${MESSAGE_SEND_FAILED_EVENT}', handleSendFailed)`);
  });
});

// A person's socket send may be only what the legacy composer sends; the
// other types are written by the platform. Refused, never coerced.
describe('the socket message type', () => {
  const check = (messageType) => refuseSocketMessageType({ podId: 'p1', content: 'hi', messageType });
  const refused = (messageType) => ({
    ...MESSAGE_TYPE_NOT_ALLOWED, podId: 'p1', content: 'hi', messageType: String(messageType),
  });

  it('admits text, which the composer sends', () => {
    expect(check('text')).toBeNull();
  });

  it('admits image, which the composer sends after an upload', () => {
    expect(check('image')).toBeNull();
  });

  it('refuses system, the platform\'s line type', () => {
    expect(check('system')).toEqual(refused('system'));
  });

  it('refuses card, the platform\'s card type', () => {
    expect(check('card')).toEqual(refused('card'));
  });

  it('refuses file, which no socket composer sends', () => {
    expect(check('file')).toEqual(refused('file'));
  });

  it('refuses gif, which no socket composer sends', () => {
    expect(check('gif')).toEqual(refused('gif'));
  });

  it('refuses a near-miss spelling rather than normalising it', () => {
    expect(check('System')).toEqual(refused('System'));
  });

  it('refuses a type that is not a string', () => {
    expect(check({ toString: () => 'text' })).toEqual(expect.objectContaining({ code: 'MESSAGE_TYPE_NOT_ALLOWED' }));
    expect(check(null)).toEqual(refused(null));
  });

  // The handler is inline in server.ts and needs a live server; pin that it
  // answers the refusal on the refused-send event before either store write.
  describe('in the sendMessage handler', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../server.ts'), 'utf8');
    const start = src.indexOf("'sendMessage',");
    const handler = src.slice(start, src.indexOf('socket.on(', start + 1));
    const refusal = handler.indexOf('refuseSocketMessageType(');

    it('checks the type before the PG and the MongoDB write', () => {
      expect(refusal).toBeGreaterThan(-1);
      expect(refusal).toBeLessThan(handler.indexOf('writeSocketMessage('));
      expect(refusal).toBeLessThan(handler.indexOf('new Message('));
    });

    it('answers on the refused-send event and stops', () => {
      const branch = handler.slice(refusal, handler.indexOf('}', handler.indexOf('if (typeRefusal)')) + 1);
      expect(branch).toContain('socket.emit(socketWrite.MESSAGE_SEND_FAILED_EVENT, typeRefusal)');
      expect(branch).toContain('return;');
    });
  });
});
