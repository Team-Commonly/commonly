/**
 * Socket.IO instance manager
 * Provides a way for services to access the socket instance
 * In Kubernetes mode, uses Redis adapter for multi-pod broadcasting
 */

interface SocketIO {
  adapter: (adapter: unknown) => void;
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

    if (process.env.AGENT_PROVISIONER_K8S === '1') {
      let pubClient: RedisClient | null = null;
      let subClient: RedisClient | null = null;

      try {
        // eslint-disable-next-line global-require
        const { createAdapter } = require('@socket.io/redis-adapter');
        // eslint-disable-next-line global-require
        const { createClient } = require('redis');

        const redisHost = process.env.REDIS_HOST || 'redis';
        const redisPort = process.env.REDIS_PORT || 6379;
        const redisUrl = `redis://${redisHost}:${redisPort}`;

        console.log(`[socket.io] Connecting to Redis at ${redisUrl} for multi-pod broadcasting`);

        pubClient = createClient({
          url: redisUrl,
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
        pubClient.on('ready', handleRedisReady);
        subClient.on('ready', handleRedisReady);

        await Promise.all([
          pubClient.connect(),
          subClient.connect(),
        ]);

        io.adapter(createAdapter(pubClient, subClient));
        console.log('[socket.io] Redis adapter enabled for Kubernetes multi-pod broadcasting');
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

        console.warn('[socket.io] Continuing without Redis adapter; Redis will not be used until process restart');
      }
    } else {
      console.log('[socket.io] Running in single-pod mode (Docker Compose)');
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
