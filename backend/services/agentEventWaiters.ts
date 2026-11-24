/**
 * F597: the CAP poll verb's optional long-poll (`GET /events?waitMs=`).
 *
 * An idle external agent used to ask every ~5 s, paying auth plus an inbox
 * read each time. With `waitMs`, an empty poll is held open until an event can
 * be claimed or the wait runs out, so an idle agent asks about once per 25 s.
 *
 * Two things end a hold early:
 *   - an in-process wake from the enqueue path (`notifyAgentEventWaiters`),
 *     keyed by the same (agentName, instanceId) the poll filters on;
 *   - a periodic recheck with the lean pending-wake query, every
 *     RECHECK_INTERVAL_MS. Correctness rests on this one: an enqueue on
 *     another backend process, a GC requeue or a direct insert never signals
 *     this process, and the recheck still finds it within one interval.
 *
 * The wake is only a hint. Nothing here claims a row: the route claims through
 * the ordinary listInboxPage path, after the hold, and only while the client
 * is still connected.
 */

export const MAX_WAIT_MS = 25_000;
export const RECHECK_INTERVAL_MS = 2_500;
// Per runtime token. One agent process holds one poll; a second covers a
// restart overlapping its predecessor's open request. More than that is a
// misbehaving client, which gets today's immediate answer instead of a hold.
export const MAX_WAITERS_PER_TOKEN = 2;

export type WaitOutcome = 'woken' | 'pending' | 'timeout' | 'closed';

type Waiter = { wake: () => void; end: () => void };

const waitersByIdentity = new Map<string, Set<Waiter>>();
const waitersByToken = new Map<string, number>();
const allWaiters = new Set<Waiter>();
let shuttingDown = false;

const identityKey = (agentName: unknown, instanceId: unknown): string => (
  `${String(agentName || '').toLowerCase()}\u0000${String(instanceId || 'default')}`
);

/**
 * The requested wait in ms: 0 when absent, unparsable or non-positive (today's
 * behaviour), otherwise at most MAX_WAIT_MS.
 */
export function clampWaitMs(raw: unknown): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') return 0;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_WAIT_MS);
}

/** Wake every hold for this identity. Cheap and synchronous; never throws. */
export function notifyAgentEventWaiters(agentName: unknown, instanceId: unknown): void {
  const set = waitersByIdentity.get(identityKey(agentName, instanceId));
  if (!set) return;
  for (const waiter of [...set]) waiter.wake();
}

/**
 * Reserve one of this token's hold slots. Returns the release function, or
 * null when the token already holds MAX_WAITERS_PER_TOKEN polls.
 */
export function acquireWaiterSlot(tokenKey: string): (() => void) | null {
  if (shuttingDown) return null;
  const held = waitersByToken.get(tokenKey) || 0;
  if (held >= MAX_WAITERS_PER_TOKEN) return null;
  waitersByToken.set(tokenKey, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = (waitersByToken.get(tokenKey) || 1) - 1;
    if (now <= 0) waitersByToken.delete(tokenKey);
    else waitersByToken.set(tokenKey, now);
  };
}

/** Open holds in this process (tests and diagnostics). */
export function waiterCount(): number {
  return allWaiters.size;
}

/** Held slots across all tokens (tests and diagnostics). */
export function heldSlotCount(): number {
  let total = 0;
  for (const count of waitersByToken.values()) total += count;
  return total;
}

/**
 * Shutdown: answer every hold now (as a timeout) and take no new ones, so no
 * held poll keeps the server open or is cut off by the exit.
 */
export function endAllWaits(): void {
  shuttingDown = true;
  for (const waiter of [...allWaiters]) waiter.end();
}

/**
 * True once shutdown began. A hold that was claiming after a wake when
 * endAllWaits() ran was not registered then, so it checks this before waiting
 * again and answers at once.
 */
export function waitsEnded(): boolean {
  return shuttingDown;
}

/** Tests only: accept holds again after endAllWaits(). */
export function resetWaitersForTests(): void {
  shuttingDown = false;
}

/**
 * Wait up to `timeoutMs` for something this identity can claim. Resolves with
 * why it ended; every timer and listener is gone by then.
 *
 * `hasPending` is the lean recheck query; a throw from it counts as "no".
 * `onClose(cb)` subscribes to the client going away and returns the
 * unsubscribe.
 */
export function waitForAgentEvent({
  agentName,
  instanceId,
  timeoutMs,
  hasPending,
  onClose,
  recheckMs = RECHECK_INTERVAL_MS,
}: {
  agentName: string;
  instanceId: string;
  timeoutMs: number;
  hasPending: () => Promise<boolean>;
  onClose: (cb: () => void) => () => void;
  recheckMs?: number;
}): Promise<WaitOutcome> {
  return new Promise<WaitOutcome>((resolve) => {
    const key = identityKey(agentName, instanceId);
    let settled = false;
    let rechecking = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let recheck: ReturnType<typeof setInterval> | null = null;
    let unsubscribeClose: () => void = () => {};

    const waiter: Waiter = { wake: () => finish('woken'), end: () => finish('timeout') };

    function finish(outcome: WaitOutcome) {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (recheck) clearInterval(recheck);
      unsubscribeClose();
      allWaiters.delete(waiter);
      const set = waitersByIdentity.get(key);
      if (set) {
        set.delete(waiter);
        if (set.size === 0) waitersByIdentity.delete(key);
      }
      resolve(outcome);
    }

    allWaiters.add(waiter);
    if (!waitersByIdentity.has(key)) waitersByIdentity.set(key, new Set());
    waitersByIdentity.get(key)!.add(waiter);

    deadline = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
    recheck = setInterval(() => {
      if (settled || rechecking) return;
      rechecking = true;
      hasPending()
        .then((found) => { if (found) finish('pending'); })
        .catch(() => null)
        .finally(() => { rechecking = false; });
    }, Math.max(50, recheckMs));
    unsubscribeClose = onClose(() => finish('closed'));
  });
}
