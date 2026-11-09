/**
 * A rate-limit store shared by every backend replica, for the sign-in and
 * sign-up limiters.
 *
 * express-rate-limit's default store is in memory, so each replica counts on
 * its own. With N web replicas a caller's budget is N times the stated one,
 * since a load balancer spreads its attempts across pods. For a brute-force
 * bound that's the number that matters, so these limiters count in Redis.
 *
 * Redis being down must never turn sign-in off. Every call falls back to a
 * per-replica memory store, which is the budget the limiter had before this
 * store existed, and says so in the log once per outage. A call also falls back
 * when Redis doesn't answer within COMMAND_TIMEOUT_MS, so a hung Redis costs a
 * request a fraction of a second, not the request.
 *
 * Keys are hashed before they reach Redis: the per-address sign-in limiter keys
 * on the submitted email, which has no business sitting in Redis in the clear.
 */
import { createHash } from 'crypto';
import { MemoryStore } from 'express-rate-limit';
import type { IncrementResponse, Options, Store } from 'express-rate-limit';
import { redisPassword } from '../config/redisPassword';

export const COMMAND_TIMEOUT_MS = 500;

// INCR, and give a new key the window as its lifetime. A key that somehow has
// no expiry gets one too, so a counter can never outlive its window for good.
export const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;
// Only an existing, positive counter goes down, so a decrement can't create a
// key with no expiry or push a count below zero.
export const DECREMENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 and tonumber(redis.call('GET', KEYS[1])) > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

export interface RateLimitRedis {
  isReady: boolean;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const withTimeout = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`redis did not answer within ${COMMAND_TIMEOUT_MS}ms`)), COMMAND_TIMEOUT_MS);
  promise.then(
    (value) => { clearTimeout(timer); resolve(value); },
    (err) => { clearTimeout(timer); reject(err); },
  );
});

let sharedClient: RateLimitRedis | null = null;
let sharedClientStarted = false;

// One client for every limiter, started when the first store is built (at
// require time of the routes) and never awaited by a request: until it is
// ready, the limiters count in memory, silently, since a pod that is still
// connecting is not an outage. Off in tests, and wherever REDIS_HOST is unset
// (local dev without Redis). The connection's own errors are logged here, once
// per outage, with Redis's message (a WRONGPASS reads as one); node-redis
// never puts the password in it.
export const rateLimitRedis = (): RateLimitRedis | null => {
  if (process.env.NODE_ENV === 'test' || !process.env.REDIS_HOST) return null;
  if (!sharedClientStarted) {
    sharedClientStarted = true;
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const { createClient } = require('redis');
      const client = createClient({
        url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`,
        password: redisPassword(),
        // A command sent while disconnected fails at once instead of queueing,
        // so the store falls back instead of waiting.
        disableOfflineQueue: true,
        socket: {
          reconnectStrategy: (retries: number) => Math.min(2 ** retries * 100, 10_000),
          connectTimeout: 5_000,
        },
      });
      let failing = false;
      client.on('error', (err: Error) => {
        if (failing) return;
        failing = true;
        console.error('[rate-limit] Redis connection error; auth limiters count per replica until it recovers:', err?.message);
      });
      client.on('ready', () => {
        if (!failing) return;
        failing = false;
        console.log('[rate-limit] Redis connection recovered');
      });
      client.connect().catch(() => { /* logged by the error listener; reconnectStrategy keeps trying */ });
      sharedClient = client as RateLimitRedis;
    } catch (err) {
      console.error('[rate-limit] could not create the Redis client; limiters count per replica:', (err as Error)?.message);
    }
  }
  return sharedClient;
};

export class SharedRateLimitStore implements Store {
  readonly prefix: string;

  readonly localKeys = false;

  private windowMs = 60_000;

  private readonly memory = new MemoryStore();

  private readonly getClient: () => RateLimitRedis | null;

  // 'unknown' until the first Redis reply, so the log says once when a replica
  // starts counting in Redis, and again on each change.
  private state: 'unknown' | 'redis' | 'memory' = 'unknown';

  constructor({ name, getClient = rateLimitRedis }: { name: string; getClient?: () => RateLimitRedis | null }) {
    this.prefix = `rl:${name}:`;
    this.getClient = getClient;
    // Starts the shared client now, so it is usually connected before the
    // first sign-in arrives.
    getClient();
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  private redisKey(key: string): string {
    return `${this.prefix}${createHash('sha256').update(key).digest('hex')}`;
  }

  private ready(): RateLimitRedis | null {
    const client = this.getClient();
    return client?.isReady ? client : null;
  }

  // A command that failed on a connected client. A client that is not
  // connected is the connection's to report (rateLimitRedis), not each store's.
  private fellBack(err: unknown): void {
    if (this.state === 'memory') return;
    this.state = 'memory';
    console.error(`[rate-limit] ${this.prefix} is counting per replica until Redis answers:`, (err as Error)?.message || err);
  }

  private recovered(): void {
    if (this.state === 'redis') return;
    this.state = 'redis';
    console.log(`[rate-limit] ${this.prefix} is counting in Redis`);
  }

  async increment(key: string): Promise<IncrementResponse> {
    const client = this.ready();
    if (client) {
      try {
        const reply = await withTimeout(client.eval(INCREMENT_SCRIPT, {
          keys: [this.redisKey(key)], arguments: [String(this.windowMs)],
        }));
        const [hits, ttl] = (reply as [number | string, number | string]).map(Number);
        if (!Number.isFinite(hits) || !Number.isFinite(ttl)) throw new Error('unexpected reply from Redis');
        this.recovered();
        return { totalHits: hits, resetTime: new Date(Date.now() + ttl) };
      } catch (err) {
        this.fellBack(err);
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key: string): Promise<void> {
    const client = this.ready();
    if (client) {
      try {
        await withTimeout(client.eval(DECREMENT_SCRIPT, { keys: [this.redisKey(key)], arguments: [] }));
        return;
      } catch (err) {
        this.fellBack(err);
      }
    }
    await this.memory.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    const client = this.ready();
    if (client) {
      try {
        await withTimeout(client.del(this.redisKey(key)));
      } catch (err) {
        this.fellBack(err);
      }
    }
    await this.memory.resetKey(key);
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  COMMAND_TIMEOUT_MS, DECREMENT_SCRIPT, INCREMENT_SCRIPT, SharedRateLimitStore, rateLimitRedis,
};
