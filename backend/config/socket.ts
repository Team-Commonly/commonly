/**
 * Socket.IO instance manager
 * Provides a way for services to access the socket instance
 * In Kubernetes mode, uses Redis adapter for multi-pod broadcasting
 */

interface SocketIO {
  adapter: (adapter: unknown) => void;
  [key: string]: unknown;
}

let io: SocketIO | null = null;

module.exports = {
  init: async (socketInstance: SocketIO): Promise<void> => {
    io = socketInstance;

    if (process.env.AGENT_PROVISIONER_K8S === '1') {
      try {
        // eslint-disable-next-line global-require
        const { createAdapter } = require('@socket.io/redis-adapter');
        // eslint-disable-next-line global-require
        const { createClient } = require('redis');

        const redisHost = process.env.REDIS_HOST || 'redis';
        const redisPort = process.env.REDIS_PORT || 6379;
        const redisUrl = `redis://${redisHost}:${redisPort}`;

        console.log(`[socket.io] Connecting to Redis at ${redisUrl} for multi-pod broadcasting`);

        const pubClient = createClient({ url: redisUrl });
        const subClient = (pubClient as { duplicate: () => unknown }).duplicate();

        (pubClient as { on: (event: string, cb: (err: unknown) => void) => void }).on('error', (err) => console.error('[socket.io] Redis pub client error:', err));
        (subClient as { on: (event: string, cb: (err: unknown) => void) => void }).on('error', (err) => console.error('[socket.io] Redis sub client error:', err));

        await Promise.all([
          (pubClient as { connect: () => Promise<void> }).connect(),
          (subClient as { connect: () => Promise<void> }).connect(),
        ]);

        io.adapter(createAdapter(pubClient, subClient));
        console.log('[socket.io] Redis adapter enabled for Kubernetes multi-pod broadcasting');
      } catch (error) {
        const e = error as { message?: string };
        console.error('[socket.io] Failed to initialize Redis adapter:', e.message);
        console.warn('[socket.io] Continuing without Redis adapter (single-pod mode)');
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
