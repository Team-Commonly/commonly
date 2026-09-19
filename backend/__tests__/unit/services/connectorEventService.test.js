/**
 * TASK-135 — the user-scoped invalidation that lets a VISIBLE Connectors tab
 * re-read when another client of the same user changes something.
 *
 * The properties that matter are the ones a wrong version fails silently on:
 * an event sent to the wrong room reaches nobody (or everyone), a payload with
 * the wrong shape still emits, and an unbound socket.io must be a no-op rather
 * than a throw from inside a route that already committed its write. So this
 * pins the room, the event name, the payload, and the three no-op paths —
 * without needing a server.
 */
const {
  bindSocketIO,
  emitConnectorsChanged,
  emitConnectorsChangedFor,
  joinUserRoom,
  userRoom,
  CONNECTORS_UPDATED_EVENT,
} = require('../../../services/connectorEventService');

const USER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const OTHER = 'cccccccccccccccccccccc01';

const makeIo = () => {
  const emitted = [];
  return {
    emitted,
    io: {
      to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
    },
  };
};

describe('connectorEventService', () => {
  test('emits into the user room, not a pod room', () => {
    const { emitted, io } = makeIo();
    bindSocketIO(io);

    emitConnectorsChanged(USER, 'grant-created');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe(`user_${USER}`);
    expect(emitted[0].event).toBe(CONNECTORS_UPDATED_EVENT);
    expect(emitted[0].payload).toEqual({ userId: USER, reason: 'grant-created' });
    // A pod room would reach members who cannot read the row; that is the
    // mistake this event exists to avoid.
    expect(emitted[0].room).not.toContain('pod_');
  });

  test('an ObjectId user id is stringified, so the room matches the joined one', () => {
    const { emitted, io } = makeIo();
    bindSocketIO(io);
    const objectId = { toString: () => USER };

    emitConnectorsChanged(objectId, 'integration-updated');

    expect(emitted[0].room).toBe(`user_${USER}`);
    expect(emitted[0].payload.userId).toBe(USER);
  });

  test('no user id and no bound socket are both silent no-ops', () => {
    const { emitted, io } = makeIo();
    bindSocketIO(io);

    emitConnectorsChanged(undefined, 'integration-deleted');
    emitConnectorsChanged(null, 'integration-deleted');
    emitConnectorsChanged('', 'integration-deleted');
    expect(emitted).toHaveLength(0);
  });

  test('an unbound socket.io does not throw', () => {
    // Re-require in a fresh registry so `ioRef` is null, the state every test
    // run and every script path starts in.
    jest.resetModules();
    // eslint-disable-next-line global-require
    const fresh = require('../../../services/connectorEventService');
    expect(() => fresh.emitConnectorsChanged(USER, 'grant-revoked')).not.toThrow();
  });

  test('a throwing transport is swallowed: the write already committed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bindSocketIO({
      to: () => ({
        emit: () => { throw new Error('transport down'); },
      }),
    });

    expect(() => emitConnectorsChanged(USER, 'grant-created')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('emitConnectorsChangedFor reads the id wherever the auth path put it', () => {
    // The three shapes are not interchangeable: the JWT middleware sets
    // `req.userId`, the populated shapes use `req.user.id` / `req.user._id`,
    // and the agent runtime token sets `req.agentUser._id`. A helper that
    // reads only one emits to nobody while the route returns 201.
    test.each([
      ['req.userId', { userId: USER }],
      ['req.user.id', { user: { id: USER } }],
      ['req.user._id', { user: { _id: USER } }],
      ['req.agentUser._id', { agentUser: { _id: USER } }],
    ])('%s', (_label, req) => {
      const { emitted, io } = makeIo();
      bindSocketIO(io);

      emitConnectorsChangedFor(req, 'grant-created');

      expect(emitted).toHaveLength(1);
      expect(emitted[0].room).toBe(`user_${USER}`);
    });

    test('an empty request emits nothing rather than a user_undefined room', () => {
      const { emitted, io } = makeIo();
      bindSocketIO(io);

      emitConnectorsChangedFor({}, 'grant-created');
      emitConnectorsChangedFor(null, 'grant-created');
      emitConnectorsChangedFor(undefined, 'grant-created');

      expect(emitted).toHaveLength(0);
    });

    test('userId wins over a populated user, matching the routes’ own derivation', () => {
      const { emitted, io } = makeIo();
      bindSocketIO(io);

      emitConnectorsChangedFor({ userId: USER, user: { id: OTHER } }, 'grant-created');

      expect(emitted[0].room).toBe(`user_${USER}`);
    });
  });

  test('userRoom is the single spelling of the room name', () => {
    expect(userRoom(USER)).toBe(`user_${USER}`);
  });

  describe('joinUserRoom', () => {
    // server.ts is not importable in a test, so the join itself is pinned here.
    // A missing join is the silent failure this whole event exists to avoid:
    // every emit still succeeds and reaches an empty room.
    test('joins the socket to its own user room', () => {
      const joined = [];

      joinUserRoom({ userId: USER, join: (room) => joined.push(room) });

      expect(joined).toEqual([`user_${USER}`]);
    });

    test('an unauthenticated socket joins nothing', () => {
      const joined = [];
      const socket = { join: (room) => joined.push(room) };

      joinUserRoom(socket);
      joinUserRoom({ ...socket, userId: null });
      joinUserRoom({ ...socket, userId: '' });

      expect(joined).toEqual([]);
    });
  });
});
