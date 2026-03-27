const express = require('express');
const cors = require('cors');
const _path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const connectDB = require('./config/db');
const { connectPG } = require('./config/db-pg');
const initializePGDB = require('./config/init-pg-db');
const authRoutes = require('./routes/auth');
const postRoutes = require('./routes/posts');
const userRoutes = require('./routes/users');
const podRoutes = require('./routes/pods');
const messageRoutes = require('./routes/messages');
const uploadsRoutes = require('./routes/uploads');
const docsRoutes = require('./routes/docs');
const summariesRoutes = require('./routes/summaries');
const integrationRoutes = require('./routes/integrations');
const appPlatformRoutes = require('./routes/apps');
const discordWebhookRoutes = require('./routes/webhooks/discord');
const slackWebhookRoutes = require('./routes/webhooks/slack');
const groupMeWebhookRoutes = require('./routes/webhooks/groupme');
const telegramWebhookRoutes = require('./routes/webhooks/telegram');
const discordRoutes = require('./routes/discord');
const githubRoutes = require('./routes/github');
const analyticsRoutes = require('./routes/analytics');
const contextApiRoutes = require('./routes/contextApi');
const tasksApiRoutes = require('./routes/tasksApi');
const registryRoutes = require('./routes/registry');
const agentsRuntimeRoutes = require('./routes/agentsRuntime');
const federationRoutes = require('./routes/federation');
const moltbotProviderRoutes = require('./routes/providers/moltbot');
const activityRoutes = require('./routes/activity');
const marketplaceRoutes = require('./routes/marketplace');
const gatewayRoutes = require('./routes/gateways');
const skillsRoutes = require('./routes/skills');
const devRoutes = require('./routes/dev');
const healthRoutes = require('./routes/health');
const agentEnsembleRoutes = require('./routes/agentEnsemble');
const globalIntegrationsRoutes = require('./routes/admin/globalIntegrations');
const agentAutonomyAdminRoutes = require('./routes/admin/agentAutonomy');
const agentEventsAdminRoutes = require('./routes/admin/agentEvents');
const adminUsersRoutes = require('./routes/admin/users');
// Conditionally load PostgreSQL routes and models
let pgPodRoutes;
let pgMessageRoutes;
let pgStatusRoutes;
let PGMessage;
let _PGPod;
const Message = require('./models/Message');
const Pod = require('./models/Pod');
const User = require('./models/User');
const AgentMentionService = require('./services/agentMentionService');

// Global flag to track PostgreSQL availability
let pgAvailable = false;

if (process.env.PG_HOST) {
  pgPodRoutes = require('./routes/pg-pods');
  pgMessageRoutes = require('./routes/pg-messages');
  pgStatusRoutes = require('./routes/pg-status');
  PGMessage = require('./models/pg/Message');
  _PGPod = require('./models/pg/Pod');
}

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
const buildAllowedOrigins = () => {
  const raw = process.env.FRONTEND_URL;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return ['http://localhost:3000', 'https://app-dev.commonly.me'];
};

const allowedOrigins = buildAllowedOrigins();
const isAllowedOrigin = (origin) => !origin || allowedOrigins.includes(origin);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type'],
  },
  transports: ['websocket', 'polling'],
});

// Initialize socket instance for other services
const socketConfig = require('./config/socket');
const agentWebSocketService = require('./services/agentWebSocketService');

// Socket.io Redis adapter initialization is async in K8s mode
(async () => {
  try {
    await socketConfig.init(io);
    agentWebSocketService.init(io);
  } catch (error) {
    console.error('Failed to initialize Socket.io:', error);
    process.exit(1);
  }
})();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
  }),
);

// Raw body middleware for Discord signature verification
app.use('/api/discord/interactions', express.raw({ type: 'application/json' }));

// Slack needs the exact raw payload for signature verification; capture it while still parsing JSON
app.use(
  '/api/webhooks/slack',
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);

// Standard JSON for GroupMe and Telegram webhooks
app.use('/api/webhooks/groupme', express.json());
app.use('/api/webhooks/telegram', express.json());

// JSON parsing for all other routes
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/summaries', summariesRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/apps', appPlatformRoutes);
app.use('/api/webhooks/discord', discordWebhookRoutes);
app.use('/api/webhooks/slack', slackWebhookRoutes);
app.use('/api/webhooks/groupme', groupMeWebhookRoutes);
app.use('/api/webhooks/telegram', telegramWebhookRoutes);
app.use('/api/discord', discordRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/v1', contextApiRoutes); // Context API for MCP and external agents
app.use('/api/v1/tasks', tasksApiRoutes); // Task management for dev agents
app.use('/api/registry', registryRoutes); // Agent Registry (package manager for agents)
app.use('/api/agents/runtime', agentsRuntimeRoutes); // Runtime endpoints for external agents
app.use('/api/federation', federationRoutes); // Cross-pod federation
app.use('/api/providers/moltbot', moltbotProviderRoutes); // Moltbot provider integration
app.use('/api/activity', activityRoutes); // Activity feed
app.use('/api/marketplace', marketplaceRoutes); // Official marketplace manifest
app.use('/api/gateways', gatewayRoutes); // Gateway registry (admin)
app.use('/api/skills', skillsRoutes); // Skill catalogs + imports
app.use('/api/admin/integrations/global', globalIntegrationsRoutes); // Admin global integrations
app.use('/api/admin/agents/autonomy', agentAutonomyAdminRoutes); // Admin manual autonomy triggers
app.use('/api/admin/agents/events', agentEventsAdminRoutes); // Admin agent event debug/queue visibility
app.use('/api/admin/users', adminUsersRoutes); // Admin user + invitation management
app.use('/api/dev', devRoutes); // Dev tooling (LLM status, etc.)
app.use('/api/health', healthRoutes); // Health check endpoints
app.use('/api/pods', agentEnsembleRoutes); // Agent Ensemble Pod endpoints

// Test routes (development only)
if (process.env.NODE_ENV === 'development') {
  const testBotRoutes = require('./routes/test-bot');
  app.use('/api/test/bot', testBotRoutes);
}

// Connect to MongoDB (for posts and user data)
connectDB();

// Bootstrap agent registry after MongoDB connects
const mongoose = require('mongoose');
const AgentBootstrapService = require('./services/agentBootstrapService');
const { AgentInstallation } = require('./models/AgentRegistry');

mongoose.connection.once('open', () => {
  if (process.env.NODE_ENV !== 'test') {
    (async () => {
      try {
        const indexes = await AgentInstallation.collection.indexes();
        const legacyIndex = indexes.find(
          (index) => JSON.stringify(index.key) === JSON.stringify({ agentName: 1, podId: 1 }),
        );
        if (legacyIndex) {
          await AgentInstallation.collection.dropIndex(legacyIndex.name);
          console.log('[agent-installations] Dropped legacy index:', legacyIndex.name);
        }
        await AgentInstallation.syncIndexes();
      } catch (indexError) {
        console.warn('[agent-installations] Index sync failed:', indexError.message);
      }

      AgentBootstrapService.bootstrap().catch((err) => {
        console.error('[agent-bootstrap] Error:', err.message);
      });
    })();
  }
});

// Start the summarizer scheduler
const schedulerService = require('./services/schedulerService');
const discordGatewayService = require('./services/discordGatewayService');

if (process.env.NODE_ENV !== 'test') {
  console.log('Starting summarizer scheduler...');
  schedulerService.start();

  if (process.env.DISCORD_BOT_TOKEN) {
    discordGatewayService.start();
  }
}

// Connect to PostgreSQL if configured (for chat functionality)
if (process.env.PG_HOST) {
  console.log('Attempting to connect to PostgreSQL for chat functionality...');
  connectPG()
    .then((pgPool) => {
      if (pgPool) {
        // Initialize PostgreSQL database
        initializePGDB()
          .then((success) => {
            if (success) {
              // Set global flag that PostgreSQL is available
              pgAvailable = true;
              // Register PostgreSQL routes for chat functionality
              app.use('/api/pg/pods', pgPodRoutes);
              app.use('/api/pg/messages', pgMessageRoutes);
              app.use('/api/pg/status', pgStatusRoutes);
              console.log(
                'PostgreSQL routes registered for chat functionality',
              );
            } else {
              pgAvailable = false;
              console.warn(
                'PostgreSQL database initialization failed, chat functionality will use MongoDB',
              );
              // Register a dummy status endpoint to indicate PostgreSQL is not available
              app.use('/api/pg/status', (req, res) => {
                res.json({ available: false });
              });
            }
          })
          .catch((err) => {
            pgAvailable = false;
            console.error('Error initializing PostgreSQL database:', err);
            // Register a dummy status endpoint to indicate PostgreSQL is not available
            app.use('/api/pg/status', (req, res) => {
              res.json({ available: false });
            });
          });
      } else {
        pgAvailable = false;
        console.warn(
          'PostgreSQL connection failed, chat functionality will use MongoDB',
        );
        // Register a dummy status endpoint to indicate PostgreSQL is not available
        app.use('/api/pg/status', (req, res) => {
          res.json({ available: false });
        });
      }
    })
    .catch((err) => {
      pgAvailable = false;
      console.error('Error connecting to PostgreSQL:', err);
      // Register a dummy status endpoint to indicate PostgreSQL is not available
      app.use('/api/pg/status', (req, res) => {
        res.json({ available: false });
      });
    });
} else {
  pgAvailable = false;
  console.log(
    'PostgreSQL connection not configured. Chat functionality will use MongoDB.',
  );
  // Register a dummy status endpoint to indicate PostgreSQL is not available
  app.use('/api/pg/status', (req, res) => {
    res.json({ available: false });
  });
}

// Socket.io middleware for authentication
io.use((socket, next) => {
  const { token } = socket.handshake.auth;
  if (!token) {
    console.error('Socket auth error: Token not provided');
    return next(new Error('Authentication error: Token not provided'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Handle both token formats: { id: user._id } or { user: { id: user._id } }
    const userId = decoded.id || (decoded.user && decoded.user.id);

    if (!userId) {
      console.error('Socket auth error: Invalid token structure');
      return next(new Error('Authentication error: Invalid token structure'));
    }

    socket.userId = userId;
    return next();
  } catch (err) {
    console.error('Socket auth error:', err.message);
    return next(new Error('Authentication error: Invalid token'));
  }
});

const emitPresence = async (podId) => {
  if (!podId) return;
  try {
    const sockets = await io.in(`pod_${podId}`).fetchSockets();
    const userIds = Array.from(
      new Set(
        sockets
          .map((s) => s.userId)
          .filter((userId) => userId),
      ),
    );
    io.to(`pod_${podId}`).emit('podPresence', { podId, userIds });
  } catch (error) {
    console.warn('Failed to emit pod presence:', error.message);
  }
};

// Socket.io event handlers
io.on('connection', (socket) => {
  console.log(
    `New client connected (id: ${socket.id}, user: ${socket.userId})`,
  );
  socket.data.joinedPods = new Set();

  // Join a pod room
  socket.on('joinPod', async (podId) => {
    if (!podId) {
      console.warn('Socket tried to join pod without podId');
      return;
    }
    socket.join(`pod_${podId}`);
    socket.data.joinedPods.add(podId);
    console.log(`User ${socket.userId} joined pod room: pod_${podId}`);
    await emitPresence(podId);
  });

  // Leave a pod room
  socket.on('leavePod', async (podId) => {
    if (!podId) {
      console.warn('Socket tried to leave pod without podId');
      return;
    }
    socket.leave(`pod_${podId}`);
    socket.data.joinedPods.delete(podId);
    console.log(`User ${socket.userId} left pod room: pod_${podId}`);
    await emitPresence(podId);
  });

  // Send a message to a pod
  socket.on(
    'sendMessage',
    async ({ podId, content, userId, messageType = 'text', replyToMessageId = null }) => {
      try {
        // Validate required parameters - content must be present
        if (!podId || !content || !userId) {
          console.error(
            'Socket error: Missing required parameters for sendMessage',
            { podId, userId },
          );
          socket.emit('error', { message: 'Missing required parameters' });
          return;
        }

        console.log('Socket sendMessage received:', {
          podId,
          content,
          userId,
          messageType,
        });

        let message;
        // Check pod membership in MongoDB (always), but store messages in PostgreSQL if available
        const podInstance = await Pod.findById(podId);
        if (!podInstance) {
          console.error('Socket error: Pod not found', { podId });
          socket.emit('error', { message: 'Pod not found' });
          return;
        }

        // Check membership using MongoDB pod model
        if (!podInstance.members.includes(userId)) {
          console.error('Socket error: Not authorized to post in this pod', {
            podId,
            userId,
          });
          socket.emit('error', {
            message: 'Not authorized to post in this pod',
          });
          return;
        }

        // Use PostgreSQL for messages if available, otherwise fallback to MongoDB
        if (pgAvailable) {
          try {
            // Create message in PostgreSQL
            console.log('Creating message in PostgreSQL:', {
              podId,
              userId,
              content,
              messageType,
            });
            const newMessage = await PGMessage.create(
              podId,
              userId,
              content,
              messageType,
              replyToMessageId,
            );
            console.log('Message created successfully:', newMessage);

            message = await PGMessage.findById(newMessage.id);
            console.log('Message retrieved for broadcast:', message);
          } catch (dbError) {
            console.error(
              'Database error with PostgreSQL, falling back to MongoDB:',
              dbError,
            );
            try {
              // Create message in MongoDB
              const user = await User.findById(userId);
              const newMessage = new Message({
                podId,
                userId,
                content,
                messageType,
              });

              await newMessage.save();
              console.log(
                'Message saved to MongoDB after PG fallback:',
                newMessage._id,
              );

              // Populate user info
              message = {
                ...newMessage.toObject(),
                username: user.username,
                profilePicture: user.profilePicture,
              };
            } catch (mongoDbError) {
              console.error(
                'Failed to save message in MongoDB fallback:',
                mongoDbError,
              );
              socket.emit('error', {
                message: 'Failed to save message to any database',
              });
              return;
            }
          }
        } else {
          console.log('Using MongoDB for messages (PostgreSQL not available)');
          try {
            // Create message in MongoDB
            const user = await User.findById(userId);
            const newMessage = new Message({
              podId,
              userId,
              content,
              messageType,
            });

            await newMessage.save();
            console.log('Message saved to MongoDB:', newMessage._id);

            // Populate user info
            message = {
              ...newMessage.toObject(),
              username: user.username,
              profilePicture: user.profilePicture,
            };
          } catch (dbError) {
            console.error(
              'Database error creating message in MongoDB:',
              dbError,
            );
            socket.emit('error', { message: 'Failed to save message' });
            return;
          }
        }

        // Broadcast message to all users in the pod room
        // Format the message to ensure all fields are present regardless of the source
        const formattedMessage = {
          // Ensure ID fields
          _id: message._id || message.id || Date.now().toString(),
          id: message._id || message.id || Date.now().toString(),

          // Ensure content fields
          content: message.content || message.text || '',
          text: message.content || message.text || '',

          // Ensure timestamp fields
          createdAt: message.createdAt || message.created_at || new Date(),
          created_at: message.createdAt || message.created_at || new Date(),

          // Reply reference (populated by findById)
          replyTo: message.replyTo || null,

          // Ensure all other fields
          ...message,
        };

        try {
          const mentionUsername = message.username || message.userId?.username;
          await AgentMentionService.enqueueMentions({
            podId,
            message: formattedMessage,
            userId,
            username: mentionUsername,
          });
          if (podInstance.type === 'agent-admin') {
            await AgentMentionService.enqueueDmEvent({
              podId,
              message: formattedMessage,
              userId,
              username: mentionUsername,
            });
          }
        } catch (mentionError) {
          console.warn('Failed to enqueue agent mentions:', mentionError.message);
        }

        // If we have user data, standardize the userId field
        if (typeof message.userId !== 'object' && message.username) {
          // User data is separate, not an object
          formattedMessage.user_id = message.userId || message.user_id;
          formattedMessage.username = message.username;
          formattedMessage.profile_picture = message.profile_picture || message.profilePicture;

          // Create an object format too for compatibility
          formattedMessage.userId = {
            _id: message.userId || message.user_id,
            username: message.username,
            profilePicture: message.profile_picture || message.profilePicture,
          };
        }

        // Log the formatted message for debugging
        console.log('Broadcasting formatted message:', {
          id: formattedMessage._id,
          content: formattedMessage.content,
          userId: formattedMessage.userId,
          username: formattedMessage.username,
          profile_picture: formattedMessage.profile_picture,
          'userId.profilePicture': formattedMessage.userId?.profilePicture,
        });

        io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
      } catch (err) {
        console.error('Socket error:', err.message, { podId, userId });
        socket.emit('error', { message: 'Server error' });
      }
    },
  );

  // Disconnect event
  socket.on('disconnect', (reason) => {
    console.log(
      `Client disconnected (id: ${socket.id}, user: ${socket.userId}). Reason: ${reason}`,
    );
    const pods = Array.from(socket.data.joinedPods || []);
    pods.forEach((podId) => {
      emitPresence(podId);
    });
  });

  // Send a welcome message to confirm connection
  socket.emit('welcome', { message: 'Connected to chat server successfully' });
});

// Start the server only when executed directly
if (require.main === module) {
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, server };
