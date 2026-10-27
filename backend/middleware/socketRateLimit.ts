import mongoose from 'mongoose';

/**
 * Socket.IO events never pass through the HTTP rate limiters, so a client
 * holding an open socket could send messages or join and leave pod rooms as
 * fast as it liked. Each budget below mirrors an HTTP one and is keyed on the
 * signed-in user, so every tab and socket of one user draws from one bucket.
 *
 * A packet over budget, or naming a pod id that is not an ObjectId string, is
 * dropped before any handler or database read runs. The client is told with a
 * `rateLimited` event rather than `error`: the web client treats `error` as a
 * lost connection and rejoins every pod, which would only spend more budget.
 *
 * The counter is a synchronous fixed window, the same shape as the HTTP
 * limiters' MemoryStore. Synchronous so this middleware never reorders a
 * socket's packets.
 */
type Budget = { name: string; max: number };

const WINDOW_MS = 60_000;

// Every packet costs a session re-check (installSocketSessionGuard), so all
// events together get one ceiling as well.
const ANY_EVENT: Budget = { name: 'any', max: 600 };
// POST /api/messages/:podId allows 60 per minute.
const SEND_MESSAGE: Budget = { name: 'sendMessage', max: 60 };
// Joining or leaving a room reads the pod and emits presence to it. 120 per
// minute matches reading a pod by id over HTTP.
const POD_ROOM: Budget = { name: 'podRoom', max: 120 };

const EVENT_BUDGETS: Record<string, Budget> = {
  sendMessage: SEND_MESSAGE,
  joinPod: POD_ROOM,
  leavePod: POD_ROOM,
};

const windows = new Map<string, { hits: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  windows.forEach((window, key) => { if (window.resetAt <= now) windows.delete(key); });
}, WINDOW_MS).unref();

/** Counts one hit; null while within budget, else the ms until the window resets. */
const take = ({ name, max }: Budget, userId: string): number | null => {
  const now = Date.now();
  const key = `${name}:${userId}`;
  let window = windows.get(key);
  if (!window || window.resetAt <= now) {
    window = { hits: 0, resetAt: now + WINDOW_MS };
    windows.set(key, window);
  }
  window.hits += 1;
  return window.hits <= max ? null : window.resetAt - now;
};

const podIdOf = (event: string, payload: unknown): unknown => (
  event === 'sendMessage' ? (payload as { podId?: unknown } | null)?.podId : payload
);

const isPodId = (value: unknown): boolean => (
  typeof value === 'string' && mongoose.isValidObjectId(value)
);

export const installSocketEventBudget = (socket: any): void => {
  socket.use(([event, payload]: [string, unknown], next: (err?: Error) => void) => {
    const userId = String(socket.userId || '');
    const eventBudget = EVENT_BUDGETS[event];
    if (eventBudget && !isPodId(podIdOf(event, payload))) {
      console.warn(`[socket] dropped ${event}: pod id is not an ObjectId string`, { userId });
      return;
    }
    const retryAfterMs = take(ANY_EVENT, userId) ?? (eventBudget ? take(eventBudget, userId) : null);
    if (retryAfterMs !== null) {
      socket.emit('rateLimited', { event, retryAfterMs });
      return;
    }
    next();
  });
};
