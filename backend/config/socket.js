/**
 * Socket.IO instance manager
 * Provides a way for services to access the socket instance
 * In Kubernetes mode, uses Redis adapter for multi-pod broadcasting
 */

let io = null;

module.exports = {
  init: async (socketInstance) => {
    io = socketInstance;

    // Enable Redis adapter in Kubernetes mode for multi-pod Socket.io broadcasting
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
        const subClient = pubClient.duplicate();

        // Error handling
        pubClient.on('error', (err) => console.error('[socket.io] Redis pub client error:', err));
        subClient.on('error', (err) => console.error('[socket.io] Redis sub client error:', err));

        await Promise.all([pubClient.connect(), subClient.connect()]);

        io.adapter(createAdapter(pubClient, subClient));
        console.log('[socket.io] Redis adapter enabled for Kubernetes multi-pod broadcasting');
      } catch (error) {
        console.error('[socket.io] Failed to initialize Redis adapter:', error.message);
        console.warn('[socket.io] Continuing without Redis adapter (single-pod mode)');
      }
    } else {
      console.log('[socket.io] Running in single-pod mode (Docker Compose)');
    }
  },

  getIO: () => {
    if (!io) {
      throw new Error('Socket.io not initialized!');
    }
    return io;
  },
};
