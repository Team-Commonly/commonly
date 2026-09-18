/**
 * connectorEventService
 *
 * User-scoped invalidation for the Connectors surfaces. The page reads
 * `/api/integrations/user/all` (rows authored by the viewer) and the pod grant
 * surfaces; before this, a second socket of the SAME user kept rendering what
 * it read at mount until its tab was hidden and shown again (TASK-135,
 * follow-up to TASK-131). A tab that is already visible receives nothing.
 *
 * Why `user_{userId}` and not the `pod_{podId}` fan-out `taskEventService`
 * uses for the board: the Connectors page is the viewer's own inventory, so a
 * pod-room event would reach members who are not entitled to those rows. The
 * alternative — subscribing the page to each listed pod's room — goes through
 * `joinPod`, which also emits presence, and would mark the viewer present in
 * every pod the page lists. The user room needs neither: it is joined once at
 * connection from the JWT the socket already presented.
 *
 * Payload shape: { userId, reason }, where `reason` names the write path that
 * moved. One event name is deliberate — every consumer re-reads the same two
 * sources, so a finer partition would only add names to keep in sync.
 *
 * Safe no-op when socket.io has not been bound (tests, scripts, CLI paths).
 */

interface SocketIOLike {
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
}

export interface ConnectorEventPayload {
  userId: string;
  reason: string;
}

let ioRef: SocketIOLike | null = null;

export function bindSocketIO(io: SocketIOLike): void {
  ioRef = io;
}

export const CONNECTORS_UPDATED_EVENT = 'connectors_updated';

/** The room a user's own sockets join at connection (server.ts). */
export const userRoom = (userId: unknown): string => `user_${String(userId)}`;

/**
 * Join a connected socket to its own user room. Called once at connection.
 * The client never asks for this room and cannot name another user's: the id
 * comes from the verified token the middleware already put on the socket.
 */
export function joinUserRoom(socket: { join: (room: string) => void; userId?: unknown }): void {
  if (!socket || !socket.userId) return;
  socket.join(userRoom(socket.userId));
}

/**
 * Tell every socket of `userId` that a source behind the Connectors page
 * moved. `reason` is for diagnosis and filtering; consumers re-read.
 */
export function emitConnectorsChanged(userId: unknown, reason: string): void {
  if (!ioRef || !userId) return;
  const payload: ConnectorEventPayload = { userId: String(userId), reason };
  try {
    ioRef.to(userRoom(userId)).emit(CONNECTORS_UPDATED_EVENT, payload);
  } catch (err) {
    console.warn('[connector-event] emit failed:', (err as Error).message);
  }
}

/**
 * Route-shaped wrapper. The three auth paths that reach a user id do not agree
 * on where it lives (`req.userId` on the JWT middleware, `req.user.id` /
 * `req.user._id` from populated shapes, `req.agentUser._id` on the runtime
 * token path), and a caller that reads only one of them silently emits to
 * nobody. Mirrors the `userId` derivation the routes themselves must use.
 */
export function emitConnectorsChangedFor(
  req: {
    userId?: unknown;
    user?: { id?: unknown; _id?: unknown };
    agentUser?: { _id?: unknown };
  } | null | undefined,
  reason: string,
): void {
  const userId = req?.userId || req?.user?.id || req?.user?._id || req?.agentUser?._id;
  emitConnectorsChanged(userId, reason);
}

export default {
  bindSocketIO,
  emitConnectorsChanged,
  emitConnectorsChangedFor,
  joinUserRoom,
  userRoom,
  CONNECTORS_UPDATED_EVENT,
};
