/**
 * Room operations that take effect in this process at once, whatever Redis is
 * doing, and reach the other backend processes through the adapter.
 *
 * With the socket.io Redis adapter (config/socket.ts), disconnectSockets and
 * socketsLeave only PUBLISH a request: each process, this one included,
 * applies it when the request comes back from Redis. While Redis is down the
 * publish waits in node-redis's offline queue, so a revoked session, a pod
 * leave or a revoked agent token would keep its socket for the whole outage.
 * And fetchSockets waits on Redis before it even starts its own timeout.
 *
 * So each operation runs on this process's own sockets first (`.local`), then
 * cluster-wide. Running it twice here is harmless: a disconnected socket is
 * gone, a left room is left. Without the adapter both calls are local.
 */

type SocketLike = { rooms: Set<string>; data?: Record<string, unknown>; [key: string]: unknown };

interface RoomOps {
  disconnectSockets(close?: boolean): void;
  socketsLeave(room: string | string[]): void;
  fetchSockets(): Promise<SocketLike[]>;
}

/** A socket.io Server or Namespace. */
export interface RoomScope {
  in(room: string): RoomOps;
  local?: { in(room: string): RoomOps };
}

const localOps = (scope: RoomScope, room: string): RoomOps | null => scope.local?.in?.(room) || null;

export const disconnectRoom = (scope: RoomScope, room: string): void => {
  localOps(scope, room)?.disconnectSockets(true);
  scope.in(room).disconnectSockets(true);
};

export const leaveRoom = (scope: RoomScope, room: string, leave: string): void => {
  localOps(scope, room)?.socketsLeave(leave);
  scope.in(room).socketsLeave(leave);
};

export const FETCH_SOCKETS_DEADLINE_MS = 2000;

/**
 * Every process's sockets in the room, or this process's alone when the
 * cluster doesn't answer within the deadline.
 */
export const fetchRoomSockets = async (
  scope: RoomScope,
  room: string,
  deadlineMs = FETCH_SOCKETS_DEADLINE_MS,
): Promise<SocketLike[]> => {
  const local = localOps(scope, room);
  const cluster = scope.in(room).fetchSockets();
  if (!local) return cluster;
  // A late answer, or the adapter's own timeout, must not surface as an
  // unhandled rejection.
  cluster.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cluster,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fetchSockets deadline')), deadlineMs);
      }),
    ]);
  } catch {
    return local.fetchSockets();
  } finally {
    clearTimeout(timer);
  }
};
