/**
 * config/socketRooms.ts: with the Redis adapter, a cluster-wide room operation
 * is only published, and applied here when Redis echoes it back. While Redis is
 * down that never happens, so each operation must also act on this process's
 * own sockets at once, and fetchSockets must fall back to them.
 */
const {
  disconnectRoom, leaveRoom, fetchRoomSockets,
} = require('../../../config/socketRooms');

// A scope whose cluster operations are swallowed, as when the adapter's
// publishes sit in node-redis's offline queue during an outage.
const outageScope = () => {
  const local = {
    disconnectSockets: jest.fn(),
    socketsLeave: jest.fn(),
    fetchSockets: jest.fn(async () => [{ rooms: new Set(['pod_1']), data: { userId: 'u1' } }]),
  };
  const cluster = {
    disconnectSockets: jest.fn(),
    socketsLeave: jest.fn(),
    fetchSockets: jest.fn(() => new Promise(() => {})),
  };
  return {
    local, cluster, scope: { in: jest.fn(() => cluster), local: { in: jest.fn(() => local) } },
  };
};

describe('socketRooms', () => {
  test('a disconnect acts on this process at once, and is sent to the others', () => {
    const { scope, local, cluster } = outageScope();
    disconnectRoom(scope, 'session_user_u1');
    expect(scope.local.in).toHaveBeenCalledWith('session_user_u1');
    expect(local.disconnectSockets).toHaveBeenCalledWith(true);
    expect(cluster.disconnectSockets).toHaveBeenCalledWith(true);
  });

  test('a room leave acts on this process at once, and is sent to the others', () => {
    const { scope, local, cluster } = outageScope();
    leaveRoom(scope, 'session_user_u1', 'pod_9');
    expect(local.socketsLeave).toHaveBeenCalledWith('pod_9');
    expect(cluster.socketsLeave).toHaveBeenCalledWith('pod_9');
  });

  test('fetchSockets falls back to this process when the cluster does not answer', async () => {
    jest.useFakeTimers();
    try {
      const { scope } = outageScope();
      const pending = fetchRoomSockets(scope, 'pod_1', 2000);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toEqual([{ rooms: new Set(['pod_1']), data: { userId: 'u1' } }]);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a cluster answer in time is used, and a late rejection is never unhandled', async () => {
    const { scope, cluster, local } = outageScope();
    cluster.fetchSockets.mockResolvedValueOnce([{ rooms: new Set(), data: { userId: 'remote' } }]);
    await expect(fetchRoomSockets(scope, 'pod_1')).resolves.toEqual([{ rooms: new Set(), data: { userId: 'remote' } }]);
    expect(local.fetchSockets).not.toHaveBeenCalled();

    jest.useFakeTimers();
    try {
      let reject;
      cluster.fetchSockets.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
      const pending = fetchRoomSockets(scope, 'pod_1', 10);
      await jest.advanceTimersByTimeAsync(10);
      await pending;
      reject(new Error('timeout reached while waiting for fetchSockets response'));
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  test('without an adapter (no `local` scope) it is one plain call', async () => {
    const ops = { disconnectSockets: jest.fn(), socketsLeave: jest.fn(), fetchSockets: jest.fn(async () => []) };
    const scope = { in: jest.fn(() => ops) };
    disconnectRoom(scope, 'r');
    expect(ops.disconnectSockets).toHaveBeenCalledTimes(1);
    await expect(fetchRoomSockets(scope, 'r')).resolves.toEqual([]);
  });
});
