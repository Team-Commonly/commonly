/**
 * Cross-process signals over Redis pub/sub, for state each backend process
 * keeps in its own memory.
 *
 * A process that changes such state (clears a cache, wakes a waiter, pushes to
 * an agent socket) does it locally as before and publishes the same signal
 * here; every OTHER process applies it to its own copy. A process never
 * receives its own messages, so the local path is never applied twice.
 *
 * It is a hint channel, not a queue: a message published while Redis is
 * unreachable is dropped, and nobody replays it. Every subscriber therefore
 * keeps its own backstop (a cache TTL, a poll, a periodic recheck), which
 * bounds how stale a missed message can leave it. A process that cannot accept
 * that (REQUIRE_SHARED_REDIS=1) stops serving on a lost connection instead
 * (config/sharedRedisRequired.ts).
 *
 * Off (every call a no-op) in tests and wherever REDIS_HOST is unset, so a
 * single-process install behaves exactly as it did.
 */
import { randomBytes } from 'crypto';
import { redisPassword } from '../config/redisPassword';
import { sharedRedisLost } from '../config/sharedRedisRequired';

type Payload = Record<string, unknown>;
type Handler = (payload: Payload) => void;

interface BusClient {
  isReady: boolean;
  connect(): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  duplicate(): BusClient;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

const CHANNEL_PREFIX = 'commonly:bus:';
// Distinguishes this process's own messages from its siblings'.
const ORIGIN = randomBytes(8).toString('hex');

const handlers = new Map<string, Set<Handler>>();
let pubClient: BusClient | null = null;
let subClient: BusClient | null = null;
let started = false;
let publishFailing = false;

const defaultCreateClient = (): BusClient => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { createClient } = require('redis');
  return createClient({
    url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`,
    password: redisPassword(),
    // A publish while disconnected fails at once rather than queueing behind
    // the reconnect: a stale hint delivered late is worse than none.
    disableOfflineQueue: true,
    socket: {
      reconnectStrategy: (retries: number) => Math.min(2 ** retries * 100, 10_000),
      connectTimeout: 5_000,
    },
  }) as BusClient;
};

let createClient: () => BusClient = defaultCreateClient;
let enabledOverride: boolean | null = null;

export const processBusEnabled = (): boolean => (
  enabledOverride ?? (process.env.NODE_ENV !== 'test' && Boolean(process.env.REDIS_HOST))
);

const deliver = (channel: string, raw: string): void => {
  let message: { o?: string; p?: Payload };
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || message.o === ORIGIN) return;
  for (const handler of handlers.get(channel) || []) {
    try {
      handler(message.p || {});
    } catch (error) {
      console.error(`[process-bus] a ${channel} handler failed:`, (error as Error)?.message || error);
    }
  }
};

const listen = (client: BusClient, channel: string): void => {
  client.subscribe(`${CHANNEL_PREFIX}${channel}`, (raw) => deliver(channel, raw)).catch((error) => {
    console.error(`[process-bus] could not subscribe to ${channel}:`, (error as Error)?.message || error);
  });
};

const watch = (client: BusClient, role: string): void => {
  let failing = false;
  client.on('error', (error) => {
    sharedRedisLost(`the process bus (${role})`, error);
    if (failing) return;
    failing = true;
    console.error(`[process-bus] Redis ${role} connection error; cross-process signals fall back to each process's own backstop:`, (error as Error)?.message);
  });
  client.on('end', () => sharedRedisLost(`the process bus (${role})`));
  client.on('ready', () => {
    if (!failing) return;
    failing = false;
    console.log(`[process-bus] Redis ${role} connection recovered`);
  });
};

/**
 * Connects the bus. Called once by server.ts when it serves; until then (and in
 * scripts, which import these modules but never serve) subscribe() only
 * registers and publish() is a no-op, so no script holds a Redis connection.
 */
export const startProcessBus = (): void => {
  if (started || !processBusEnabled()) return;
  started = true;
  try {
    pubClient = createClient();
    subClient = pubClient.duplicate();
    watch(pubClient, 'publish');
    watch(subClient, 'subscribe');
    pubClient.connect().catch((error) => sharedRedisLost('the process bus (publish)', error));
    // node-redis keeps a subscriber's channels across reconnects, so each
    // channel is subscribed once, here or in subscribe() below.
    subClient.connect().then(() => {
      for (const channel of handlers.keys()) listen(subClient as BusClient, channel);
    }, (error) => sharedRedisLost('the process bus (subscribe)', error));
  } catch (error) {
    console.error('[process-bus] could not create the Redis clients:', (error as Error)?.message || error);
    sharedRedisLost('the process bus', error);
  }
};

/** Every other process runs `handler` for each message published on `channel`. */
export const subscribe = (channel: string, handler: Handler): void => {
  const isNew = !handlers.has(channel);
  if (isNew) handlers.set(channel, new Set());
  (handlers.get(channel) as Set<Handler>).add(handler);
  // Before the bus starts, or while it connects, startProcessBus() subscribes
  // every registered channel once connected.
  if (isNew && subClient?.isReady) listen(subClient, channel);
};

/** Tell every other process. Fire-and-forget; dropped while Redis is down. */
export const publish = (channel: string, payload: Payload = {}): void => {
  if (!pubClient?.isReady) return;
  pubClient.publish(`${CHANNEL_PREFIX}${channel}`, JSON.stringify({ o: ORIGIN, p: payload })).then(() => {
    if (!publishFailing) return;
    publishFailing = false;
    console.log('[process-bus] publishing again');
  }, (error) => {
    if (publishFailing) return;
    publishFailing = true;
    console.error(`[process-bus] a ${channel} publish failed; siblings rely on their backstop:`, (error as Error)?.message || error);
  });
};

/** Tests only: a fake client factory, and on/off regardless of env. */
export const setProcessBusForTests = (
  { factory, enabled }: { factory?: () => BusClient; enabled?: boolean | null } = {},
): void => {
  createClient = factory || defaultCreateClient;
  enabledOverride = enabled ?? null;
  handlers.clear();
  pubClient = null;
  subClient = null;
  started = false;
  publishFailing = false;
};

export const PROCESS_BUS_ORIGIN_FOR_TESTS = ORIGIN;
