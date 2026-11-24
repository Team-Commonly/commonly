/**
 * Socket.IO instance manager
 * Provides a way for services to access the socket instance.
 *
 * Uses the Redis adapter wherever Redis is configured (REDIS_HOST, or the
 * chart's `redis` Service under AGENT_PROVISIONER_K8S=1), so a pod-room emit,
 * a socketsLeave and a disconnectSockets reach the sockets every backend
 * process holds. A process that does not require shared Redis falls back to
 * local delivery when Redis fails at boot, which is correct while it is the
 * only process. One started with REQUIRE_SHARED_REDIS=1 stops serving instead,
 * at boot or on any later loss (config/sharedRedisRequired.ts).
 */
import { onSharedRedisLost, sharedRedisLost, sharedRedisRequired } from './sharedRedisRequired';

const ADAPTER_CONNECT_DEADLINE_MS = Number(process.env.REDIS_ADAPTER_CONNECT_DEADLINE_MS) || 15_000;

interface LocalOps {
  disconnectSockets: (close?: boolean) => void;
}

interface SocketIO {
  adapter: (adapter: unknown) => void;
  local?: LocalOps;
  of?: (namespace: string) => { local?: LocalOps };
  [key: string]: unknown;
}

interface RedisClient {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  duplicate: () => RedisClient;
  on: (event: string, callback: (...args: unknown[]) => void) => unknown;
}

let io: SocketIO | null = null;

module.exports = {
  init: async (socketInstance: SocketIO): Promise<void> => {
    io = socketInstance;
    // A process that loses shared Redis drops its own sockets, browsers' and
    // agents', before it stops, so their clients reconnect to a process that
    // is still whole. `.local`: through the adapter this would be published,
    // queued while Redis is down and, once delivered, drop every other
    // process's sockets too.
    onSharedRedisLost(() => {
      socketInstance.local?.disconnectSockets(true);
      socketInstance.of?.('/agents').local?.disconnectSockets(true);
    });

    if (process.env.AGENT_PROVISIONER_K8S === '1' || process.env.REDIS_HOST) {
      let pubClient: RedisClient | null = null;
      let subClient: RedisClient | null = null;

      try {
        // eslint-disable-next-line global-require
        const { createAdapter } = require('@socket.io/redis-adapter');
        // eslint-disable-next-line global-require
        const { createClient } = require('redis');
        // eslint-disable-next-line global-require
        const { redisPassword } = require('./redisPassword');

        const redisHost = process.env.REDIS_HOST || 'redis';
        const redisPort = process.env.REDIS_PORT || 6379;
        const redisUrl = `redis://${redisHost}:${redisPort}`;

        console.log(`[socket.io] Connecting to Redis at ${redisUrl} for multi-pod broadcasting`);

        pubClient = createClient({
          url: redisUrl,
          // Trimmed via redisPassword() so a secret with a trailing newline
          // still authenticates; undefined when unset (local/dev) -> node-redis
          // sends no AUTH. Single source shared with the /api/health probe.
          password: redisPassword(),
          socket: {
            reconnectStrategy: (retries: number) => Math.min(2 ** retries * 100, 10_000),
            connectTimeout: 5_000,
          },
        }) as RedisClient;
        subClient = pubClient.duplicate();

        // node-redis can emit an error on every failed reconnect. Log only when
        // the Redis connection enters or leaves the error state.
        let redisErrorActive = false;
        const handleRedisError = (err: unknown): void => {
          // A broadcast published while either client is down never reaches
          // the other processes, a revocation included.
          sharedRedisLost('the socket.io adapter', err);
          if (!redisErrorActive) {
            redisErrorActive = true;
            console.error('[socket.io] Redis clients entered error state:', err);
          }
        };
        const handleRedisReady = (): void => {
          if (redisErrorActive) {
            redisErrorActive = false;
            console.log('[socket.io] Redis clients recovered');
          }
        };

        pubClient.on('error', handleRedisError);
        subClient.on('error', handleRedisError);
        pubClient.on('end', () => sharedRedisLost('the socket.io adapter'));
        subClient.on('end', () => sharedRedisLost('the socket.io adapter'));
        pubClient.on('ready', handleRedisReady);
        subClient.on('ready', handleRedisReady);

        // node-redis retries a failed connect forever, and the agent socket
        // namespace is set up only after this returns, so the wait is bounded.
        // Past it, a process that requires shared Redis stops (below). Any
        // other process attaches the adapter anyway, with its clients still
        // retrying: node-redis queues commands while a client is open and
        // re-subscribes its channels on every connect, so the process joins
        // the cluster by itself once Redis answers. It never serves on a
        // different delivery path from its peers, and needs no restart.
        // Meanwhile its revocations act locally (config/socketRooms).
        const connecting = Promise.all([pubClient.connect(), subClient.connect()]);
        connecting.catch(() => undefined); // a failure after the deadline is handled by the error listeners
        let timedOut = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            connecting,
            new Promise((_, reject) => {
              deadline = setTimeout(() => {
                timedOut = true;
                reject(new Error(`Redis did not answer within ${ADAPTER_CONNECT_DEADLINE_MS / 1000}s`));
              }, ADAPTER_CONNECT_DEADLINE_MS);
            }),
          ]);
        } catch (connectError) {
          if (!timedOut || sharedRedisRequired()) throw connectError;
          console.warn(`[socket.io] Redis did not answer within ${ADAPTER_CONNECT_DEADLINE_MS / 1000}s; attaching the adapter anyway, and it joins the other processes once Redis is up`);
        } finally {
          clearTimeout(deadline);
        }

        io.adapter(createAdapter(pubClient, subClient));
        console.log('[socket.io] Redis adapter enabled for multi-process broadcasting');
      } catch (error) {
        const e = error as { message?: string };
        console.error('[socket.io] Failed to initialize Redis adapter:', e.message);

        // Stop node-redis's reconnect loop. quit() requires a live socket, but
        // this path is specifically for clients that failed during connect.
        for (const client of [pubClient, subClient]) {
          if (client) {
            try {
              await client.disconnect();
            } catch (cleanupError) {
              const cleanup = cleanupError as { message?: string };
              console.warn('[socket.io] Failed to stop Redis client after initialization error:', cleanup.message);
            }
          }
        }

        if (sharedRedisLost('the socket.io adapter', error)) return;
        console.warn('[socket.io] Continuing without Redis adapter; Redis will not be used until process restart');
      }
    } else {
      // No Redis configured: a process that must share it can't serve.
      if (sharedRedisLost('the socket.io adapter', new Error('REDIS_HOST is not set'))) return;
      console.log('[socket.io] Running in single-process mode (no Redis configured)');
    }
  },

  getIO: (): SocketIO => {
    if (!io) {
      throw new Error('Socket.io not initialized!');
    }
    return io;
  },
};
export {};
