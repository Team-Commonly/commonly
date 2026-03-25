const express = require('express');
const mongoose = require('mongoose');
const { pool: pgPool } = require('../config/db-pg');

const router = express.Router();

/**
 * GET /api/health
 * Comprehensive health check endpoint for monitoring
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks: {},
  };

  // Check MongoDB connection
  try {
    const mongoState = mongoose.connection.readyState;
    const mongoStates = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };

    if (mongoState === 1) {
      // Run a quick ping to verify connection is actually working
      await mongoose.connection.db.admin().ping();
      health.checks.mongodb = {
        status: 'healthy',
        state: mongoStates[mongoState],
        latency: `${Date.now() - startTime}ms`,
      };
    } else {
      health.checks.mongodb = {
        status: 'unhealthy',
        state: mongoStates[mongoState] || 'unknown',
        error: 'Not connected',
      };
      health.status = 'degraded';
    }
  } catch (error) {
    health.checks.mongodb = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check PostgreSQL connection
  try {
    if (process.env.PG_HOST && pgPool) {
      const pgStart = Date.now();
      const result = await pgPool.query('SELECT 1 as ok');
      if (result.rows[0]?.ok === 1) {
        health.checks.postgresql = {
          status: 'healthy',
          latency: `${Date.now() - pgStart}ms`,
        };
      } else {
        health.checks.postgresql = {
          status: 'unhealthy',
          error: 'Query failed',
        };
        health.status = 'degraded';
      }
    } else {
      health.checks.postgresql = {
        status: 'not_configured',
        message: 'PostgreSQL not configured (PG_HOST not set)',
      };
    }
  } catch (error) {
    health.checks.postgresql = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check Redis connection (K8s mode for Socket.io adapter)
  if (process.env.AGENT_PROVISIONER_K8S === '1') {
    try {
      // eslint-disable-next-line global-require
      const { createClient } = require('redis');
      const redisHost = process.env.REDIS_HOST || 'redis';
      const redisPort = process.env.REDIS_PORT || 6379;
      const redisClient = createClient({ url: `redis://${redisHost}:${redisPort}` });

      const redisStart = Date.now();
      await redisClient.connect();
      const pong = await redisClient.ping();
      await redisClient.disconnect();

      if (pong === 'PONG') {
        health.checks.redis = {
          status: 'healthy',
          latency: `${Date.now() - redisStart}ms`,
        };
      } else {
        health.checks.redis = {
          status: 'unhealthy',
          error: 'Ping failed',
        };
        health.status = 'degraded';
      }
    } catch (error) {
      health.checks.redis = {
        status: 'unhealthy',
        error: error.message,
      };
      health.status = 'degraded';
    }
  } else {
    health.checks.redis = {
      status: 'not_configured',
      message: 'Redis not configured (Docker Compose mode)',
    };
  }

  // Check external services configuration
  health.checks.services = {
    discord: {
      configured: !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID),
    },
    gemini: {
      configured: !!process.env.GEMINI_API_KEY,
    },
    litellm: {
      configured: !!(process.env.LITELLM_BASE_URL && process.env.LITELLM_MASTER_KEY),
    },
    sendgrid: {
      configured: !!process.env.SENDGRID_API_KEY,
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
    },
  };

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
    external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
  };

  // Response time
  health.responseTime = `${Date.now() - startTime}ms`;

  // Set appropriate HTTP status code
  const httpStatus = health.status === 'healthy' ? 200 : 503;
  res.status(httpStatus).json(health);
});

/**
 * GET /api/health/live
 * Simple liveness probe for Kubernetes/Docker
 */
router.get('/live', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

/**
 * GET /api/health/ready
 * Readiness probe - checks if the service can handle requests
 */
router.get('/ready', async (req, res) => {
  try {
    // Check MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        status: 'not_ready',
        reason: 'MongoDB not connected',
      });
    }

    // Optionally check PostgreSQL if configured
    if (process.env.PG_HOST && pgPool) {
      try {
        await pgPool.query('SELECT 1');
      } catch (pgError) {
        return res.status(503).json({
          status: 'not_ready',
          reason: 'PostgreSQL not connected',
        });
      }
    }

    // Check Redis in K8s mode (required for Socket.io adapter)
    if (process.env.AGENT_PROVISIONER_K8S === '1') {
      try {
        // eslint-disable-next-line global-require
        const { createClient } = require('redis');
        const redisHost = process.env.REDIS_HOST || 'redis';
        const redisPort = process.env.REDIS_PORT || 6379;
        const redisClient = createClient({ url: `redis://${redisHost}:${redisPort}` });

        await redisClient.connect();
        await redisClient.ping();
        await redisClient.disconnect();
      } catch (redisError) {
        return res.status(503).json({
          status: 'not_ready',
          reason: 'Redis not connected (required in K8s mode)',
        });
      }
    }

    res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      error: error.message,
    });
  }
});

/**
 * GET /api/health/clawdbot
 * Check Clawdbot gateway status
 */
router.get('/clawdbot', async (req, res) => {
  const gatewayUrl = process.env.CLAWDBOT_GATEWAY_URL || 'http://clawdbot-gateway:18789';

  try {
    // Try to reach the gateway health endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${gatewayUrl}/health`, {
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    if (response && response.ok) {
      const data = await response.json().catch(() => ({}));
      return res.json({
        status: 'connected',
        gateway: gatewayUrl,
        version: data.version || 'unknown',
        channels: data.channels || [],
      });
    }

    // Gateway not responding to /health, try basic connection
    const basicResponse = await fetch(gatewayUrl, {
      method: 'HEAD',
    }).catch(() => null);

    if (basicResponse) {
      return res.json({
        status: 'connected',
        gateway: gatewayUrl,
        channels: [],
      });
    }

    res.json({
      status: 'not_configured',
      message: 'Clawdbot gateway not reachable',
    });
  } catch (error) {
    res.json({
      status: 'error',
      message: error.message,
    });
  }
});

module.exports = router;
