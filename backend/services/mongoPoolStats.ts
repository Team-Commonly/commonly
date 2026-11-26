/**
 * Opt-in Mongo connection pool stats, one log line per interval (F636).
 *
 * The prod backend has one MongoClient at the driver default maxPoolSize 100,
 * and it has been seen holding ~100 sockets to the primary. A full pool only
 * says peak concurrency once reached 100; it does not say checkouts wait now.
 * This listens to the driver's CMAP events and logs whether they do.
 * Runbook: docs/runbooks/mongo-pool-stats.md. Wired in config/db.ts behind
 * MONGO_POOL_STATS=1.
 *
 * Events (mongodb 5.9.2, lib/cmap/connection_pool_events.js), relayed
 * pool -> server -> topology -> MongoClient. Every event carries `address`
 * (host:port) and `time` (a Date); checkedOut/checkedIn/created/closed carry
 * `connectionId`; checkOutFailed and closed carry `reason`. No event carries
 * a duration, so the checkout wait is approximated: each address keeps a FIFO
 * of checkOutStarted times, and a checkedOut or checkOutFailed on that address
 * shifts the oldest one. The pool's wait queue is FIFO, so the count and the
 * distribution of waits hold, but the pairing of a wait to a checkout can be
 * wrong: the pool opens up to maxConnecting (default 2) connections at once
 * and they can finish out of order, and a waiting checkout can be cancelled
 * out of order. The queue starts empty, so an end for a checkout in flight
 * when stats start counts a checkout with no wait sample (or pairs with a
 * newer start); that skew, and one from cap drops, corrects itself once the
 * queue empties. Running counts (checked out, waiting, open) are clamped at 0.
 *
 * The wait includes connect time: a checkout that has to open a new
 * connection counts the TCP/TLS handshake as wait. Waits with `created` above
 * 0 and maxCheckedOut well under the pool size point at slow new connections,
 * not saturation.
 *
 * `open` (created minus closed) can read low (connections made before stats
 * start) or high: if the pool clears while a connection is still being made,
 * the driver destroys it without a connectionClosed event.
 *
 * The address is a host, so it is never logged: lines carry numbers and the
 * count of addresses seen. A handler never throws into a query path.
 */

export const CMAP_EVENT_NAMES = [
  'connectionCheckOutStarted',
  'connectionCheckedOut',
  'connectionCheckOutFailed',
  'connectionCheckedIn',
  'connectionCreated',
  'connectionClosed',
] as const;

export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_QUEUE = 10_000;
export const WAITED_MS = 5;

type CmapEventName = typeof CMAP_EVENT_NAMES[number];
type Listener = (event: unknown) => void;

interface EmitterLike {
  on(name: string, listener: Listener): unknown;
  removeListener(name: string, listener: Listener): unknown;
}

export interface MongoPoolStatsOptions {
  intervalMs?: number;
  maxQueue?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MongoPoolStatsHandle {
  stop(): void;
  /** Emit the current interval's line now and reset it (tests, shutdown). */
  flush(): void;
}

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const addressOf = (event: unknown): string => {
  if (event && typeof event === 'object' && 'address' in event) {
    return String((event as { address: unknown }).address);
  }
  return '';
};

const reasonOf = (event: unknown): string => {
  const raw = event && typeof event === 'object' && 'reason' in event
    ? String((event as { reason: unknown }).reason) : '';
  const clean = raw.replace(/[^A-Za-z]/g, '').slice(0, 40);
  return clean || 'unknown';
};

export const startMongoPoolStats = (
  client: EmitterLike,
  opts: MongoPoolStatsOptions = {},
): MongoPoolStatsHandle => {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.log(line));

  const queues = new Map<string, number[]>();
  // running counts, never reset
  let checkedOut = 0;
  let waiting = 0;
  let open = 0;
  // interval counters
  let checkouts = 0;
  let waited = 0;
  let waits: number[] = [];
  let failed = 0;
  let failedBy = new Map<string, number>();
  let created = 0;
  let closed = 0;
  let dropped = 0;
  let maxCheckedOut = 0;
  let maxWaiting = 0;
  let warned = false;

  const queueFor = (address: string): number[] => {
    let q = queues.get(address);
    if (!q) {
      q = [];
      queues.set(address, q);
    }
    return q;
  };

  const shiftWait = (address: string): number | undefined => {
    const start = queueFor(address).shift();
    return start === undefined ? undefined : Math.max(0, now() - start);
  };

  const handlers: Record<CmapEventName, Listener> = {
    connectionCheckOutStarted: (e) => {
      const q = queueFor(addressOf(e));
      q.push(now());
      if (q.length > maxQueue) {
        q.shift();
        dropped += 1;
      }
      waiting += 1;
      maxWaiting = Math.max(maxWaiting, waiting);
    },
    connectionCheckedOut: (e) => {
      const wait = shiftWait(addressOf(e));
      checkouts += 1;
      if (wait !== undefined) {
        waits.push(wait);
        if (wait >= WAITED_MS) waited += 1;
      }
      waiting = Math.max(0, waiting - 1);
      checkedOut += 1;
      maxCheckedOut = Math.max(maxCheckedOut, checkedOut);
    },
    connectionCheckOutFailed: (e) => {
      shiftWait(addressOf(e));
      failed += 1;
      const reason = reasonOf(e);
      failedBy.set(reason, (failedBy.get(reason) ?? 0) + 1);
      waiting = Math.max(0, waiting - 1);
    },
    connectionCheckedIn: () => {
      checkedOut = Math.max(0, checkedOut - 1);
    },
    connectionCreated: () => {
      created += 1;
      open += 1;
    },
    connectionClosed: () => {
      closed += 1;
      open = Math.max(0, open - 1);
    },
  };

  const warnOnce = (err: unknown) => {
    if (warned) return;
    warned = true;
    try {
      console.warn('[mongo-pool] stats handler error (logged once):', err instanceof Error ? err.message : String(err));
    } catch {
      // nothing left to do
    }
  };

  const wrapped = new Map<CmapEventName, Listener>();
  CMAP_EVENT_NAMES.forEach((name) => {
    const listener: Listener = (event) => {
      try {
        handlers[name](event);
      } catch (err) {
        warnOnce(err);
      }
    };
    wrapped.set(name, listener);
    client.on(name, listener);
  });

  const flush = () => {
    try {
      const sorted = [...waits].sort((a, b) => a - b);
      const reasons = [...failedBy.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([r, n]) => `${r}:${n}`)
        .join(',');
      const line = `[mongo-pool] checkouts=${checkouts} waited=${waited}`
        + ` waitMs p50=${Math.round(percentile(sorted, 50))}`
        + ` p95=${Math.round(percentile(sorted, 95))}`
        + ` max=${Math.round(sorted.length ? sorted[sorted.length - 1] : 0)}`
        + ` maxCheckedOut=${maxCheckedOut} maxWaiting=${maxWaiting}`
        + ` failed=${failed} created=${created} closed=${closed} open=${open}`
        + ` servers=${queues.size} dropped=${dropped}`
        + (reasons ? ` failedReasons=${reasons}` : '');
      log(line);
    } catch (err) {
      warnOnce(err);
    }
    checkouts = 0;
    waited = 0;
    waits = [];
    failed = 0;
    failedBy = new Map();
    created = 0;
    closed = 0;
    dropped = 0;
    // a peak starts from what is still held, not from 0
    maxCheckedOut = checkedOut;
    maxWaiting = waiting;
  };

  const timer = setInterval(flush, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    flush,
    stop() {
      clearInterval(timer);
      wrapped.forEach((listener, name) => {
        try {
          client.removeListener(name, listener);
        } catch {
          // a client that can't detach has nothing more to tell us
        }
      });
      wrapped.clear();
    },
  };
};
