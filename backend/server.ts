const { attachSentryErrorHandler } = require('./instrument');
export {};
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
const podInvitesRoutes = require('./routes/podInvites');
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
const marketplaceApiRoutes = require('./routes/marketplace-api');
const gatewayRoutes = require('./routes/gateways');
const skillsRoutes = require('./routes/skills');
const devRoutes = require('./routes/dev');
const healthRoutes = require('./routes/health');
const statsRoutes = require('./routes/stats');
const emailRoutes = require('./routes/email');
const showcaseRoutes = require('./routes/showcase');
const adminPodsRoutes = require('./routes/admin/pods');
const agentEnsembleRoutes = require('./routes/agentEnsemble');
const globalIntegrationsRoutes = require('./routes/admin/globalIntegrations');
const agentAutonomyAdminRoutes = require('./routes/admin/agentAutonomy');
const agentEventsAdminRoutes = require('./routes/admin/agentEvents');
const adminUsersRoutes = require('./routes/admin/users');
const adminAnalyticsRoutes = require('./routes/admin/analytics');
const adminInstallableRoutes = require('./routes/admin/installables');
// Conditionally load PostgreSQL routes and models
let pgMessageRoutes: any;
let pgStatusRoutes: any;
let PGMessage: any;
let _PGPod;
const Message = require('./models/Message');
const Pod = require('./models/Pod');
const User = require('./models/User');
const AgentMentionService = require('./services/agentMentionService');

// Global flag to track PostgreSQL availability
let pgAvailable = false;

if (process.env.PG_HOST) {
  pgMessageRoutes = require('./routes/pg-messages');
  pgStatusRoutes = require('./routes/pg-status');
  PGMessage = require('./models/pg/Message');
  _PGPod = require('./models/pg/Pod');
}

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
// Trust the reverse proxy (Cloudflare → ingress → backend). Without this,
// `req.protocol` returns 'http' even when the public URL is HTTPS, because
// the cluster-internal hop is plain HTTP. The downstream effect: any URL
// we build with `${req.protocol}://...` (avatar uploads, profile pictures,
// pod attachments) gets emitted as `http://api.commonly.me/...` and
// triggers Mixed Content warnings in every page load. Trusting the proxy
// makes Express honor X-Forwarded-Proto.
//
// Bounded, not `true` (#652): `true` trusts every hop in X-Forwarded-For, so
// any client can spoof req.ip and bypass the IP-keyed rate limiters
// (express-rate-limit ERR_ERL_PERMISSIVE_TRUST_PROXY). Every real hop in
// front of us — cloudflared pod, nginx, docker-compose bridge, local dev —
// sits on a loopback/private address, so trusting only those ranges walks
// X-Forwarded-For from the right past our own infra and stops at the first
// public address: the client IP as recorded by Cloudflare. A spoofed header
// just gets the real client IP appended after it by the edge, so spoofing
// can't reach req.ip.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
const buildAllowedOrigins = () => {
  const raw = process.env.FRONTEND_URL;
  if (raw && raw.trim()) {
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return ['http://localhost:3000', 'https://commonly.me'];
};

const allowedOrigins = buildAllowedOrigins();
const isAllowedOrigin = (origin: any) => !origin || allowedOrigins.includes(origin);

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
const { bindSocketIO: bindAgentTypingSocketIO } = require('./services/agentTypingService');
const { bindSocketIO: bindTaskEventSocketIO } = require('./services/taskEventService');

// Socket.io Redis adapter initialization is async in K8s mode
(async () => {
  try {
    await socketConfig.init(io);
    agentWebSocketService.init(io);
    bindAgentTypingSocketIO(io);
    bindTaskEventSocketIO(io);
  } catch (error) {
    console.error('Failed to initialize Socket.io:', error);
    process.exit(1);
  }
})();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: (origin: any, callback: any) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
    // Slack OAuth starts in the authenticated shell and returns through an
    // unauthenticated callback. The browser-bound nonce is HttpOnly on the
    // API origin, so the authorize-url request must be allowed to persist it
    // when the shell is served from commonly.me.
    credentials: true,
  }),
);

// Raw body middleware for Discord signature verification
app.use('/api/discord/interactions', express.raw({ type: 'application/json' }));

// Stripe verifies the EXACT bytes it sent, so this route must never see a
// re-serialized body. Mounted here, before the global express.json() below —
// putting it after would make every webhook fail signature verification,
// which is the most common way this integration breaks.
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Slack needs the exact raw payload for signature verification; capture it while still parsing JSON
app.use(
  '/api/webhooks/slack',
  express.json({
    verify: (req: any, res: any, buf: any) => {
      req.rawBody = buf.toString();
    },
  }),
);
// Slack slash commands are form posts, but their signature is over the same
// raw bytes. Capture those too before any parser turns them into an object.
app.use(
  '/api/webhooks/slack',
  express.urlencoded({
    extended: false,
    verify: (req: any, _res: any, buf: Buffer) => {
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
// Pod invite tokens — both `/api/pods/:podId/invites` (create) and
// `/api/invites/:token` (resolve / redeem) live in the same router.
// Route-order hazard: any bare-`/api` router with a two-segment `/pods/*`
// GET must mount before `/api/pods`. Its `/:type/:id` catch-all would
// otherwise consume that request as a pod lookup.
app.use('/api', podInvitesRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/billing', require('./routes/billing'));
app.use('/api/messages', messageRoutes);
// ADR-020 D3: approval-card decisions (human-only; see routes/approvals.ts)
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/uploads', uploadsRoutes);
app.use('/api/docs', docsRoutes);
app.use('/api/summaries', summariesRoutes);
app.use('/api/integrations', integrationRoutes);
const installableRoutes = require('./routes/installables');
app.use('/api/installables', installableRoutes);
// Slack's redirect URI is deliberately a webhook URL so the Slack app's
// public surface stays together. The handler itself remains in the
// installables module because it acts on the owner-scoped installation.
app.use('/api/webhooks/slack/oauth', installableRoutes.slackOAuthCallbackRouter);
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
app.use('/api/credentials', require('./routes/credentials')); // ADR-026 Phase 0: credential lineage + revocation
app.use('/api/agent-binding', require('./routes/agentBinding')); // ADR-026 D3: machine adoption CAS
app.use('/api/machines', require('./routes/machines')); // ADR-026 Phase 1: local daemon lifecycle
app.use('/api/hosted', require('./routes/hosted')); // ADR-023 W2: hosted runtime provision surface (metered)
app.use('/api/agents/runtime', agentsRuntimeRoutes); // Runtime endpoints for external agents
app.use('/api/federation', federationRoutes); // Cross-pod federation
app.use('/api/providers/moltbot', moltbotProviderRoutes); // Moltbot provider integration
app.use('/api/activity', activityRoutes); // Activity feed
app.use('/api/marketplace', marketplaceRoutes); // Official marketplace manifest
app.use('/api/marketplace', marketplaceApiRoutes); // Publish, fork, browse APIs
app.use('/api/gateways', gatewayRoutes); // Gateway registry (admin)
app.use('/api/skills', skillsRoutes); // Skill catalogs + imports
app.use('/api/admin/integrations/global', globalIntegrationsRoutes); // Admin global integrations
app.use('/api/admin/agents/autonomy', agentAutonomyAdminRoutes); // Admin manual autonomy triggers
app.use('/api/admin/agents/events', agentEventsAdminRoutes); // Admin agent event debug/queue visibility
app.use('/api/admin/users', adminUsersRoutes); // Admin user + invitation management
app.use('/api/admin/analytics', adminAnalyticsRoutes); // Admin activation-funnel analytics (GH#661)
app.use('/api/admin/installables', adminInstallableRoutes); // Owner-private connector pause/resume
app.use('/api/dev', devRoutes); // Dev tooling (LLM status, etc.)
app.use('/api/health', healthRoutes); // Health check endpoints
app.use('/api/stats', statsRoutes); // Public stats (no auth)
app.use('/api/email', emailRoutes); // Public digest unsubscribe links
// Public read-only showcase (no auth — handlers self-gate on pod.publicRead).
// SECURITY-CRITICAL: the only anonymous read path; serves only flagged pods.
app.use('/api/showcase', showcaseRoutes);
// Public read-only agent profile (no auth — self-gates on isBot, whitelist-only).
// SECURITY-CRITICAL: anonymous read path; serves only agent identities, never
// private memory / pod names / credentials. See routes/agentProfile.ts.
app.use('/api/agent-profile', require('./routes/agentProfile'));
// Persona hiring (persona plan Phase 2) — the where-step's backend.
app.use('/api/personas', require('./routes/personas'));
// Authed owner/admin-only agent memory index (private counterpart to the public
// profile). Self-gates via auth middleware + owner/admin check inside the route.
app.use('/api/agent-memory', require('./routes/agentMemoryView'));
app.use('/api/admin/pods', adminPodsRoutes); // Admin pod ops (showcase toggle)
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
const { ensureLocalDevLogin } = require('./services/localDevLoginService');
const { AgentInstallation } = require('./models/AgentRegistry');

mongoose.connection.once('open', () => {
  if (process.env.NODE_ENV !== 'test') {
    (async () => {
      try {
        await ensureLocalDevLogin();
      } catch (localDevLoginError: any) {
        console.error('[local-dev-login] Error:', localDevLoginError.message);
      }

      try {
        const indexes = await AgentInstallation.collection.indexes();
        const legacyIndex = indexes.find(
          (index: any) => JSON.stringify(index.key) === JSON.stringify({ agentName: 1, podId: 1 }),
        );
        if (legacyIndex) {
          await AgentInstallation.collection.dropIndex(legacyIndex.name);
          console.log('[agent-installations] Dropped legacy index:', legacyIndex.name);
        }
        await AgentInstallation.syncIndexes();
      } catch (indexError: any) {
        console.warn('[agent-installations] Index sync failed:', indexError.message);
      }

      AgentBootstrapService.bootstrap().catch((err: any) => {
        console.error('[agent-bootstrap] Error:', err.message);
      });

      require('./scripts/seed-native-agents').seedNativeAgents().catch((err: any) =>
        console.error('[native-seed] failed:', err?.message || err),
      );
      require('./scripts/seed-builtin-connectors').seedBuiltinConnectors().then(() =>
        require('./services/installable/installableReconciler').sweep(),
      ).catch((err: any) =>
        console.error('[builtin-connectors] bootstrap failed:', err?.message || err),
      );
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
    .then((pgPool: any) => {
      if (pgPool) {
        // Initialize PostgreSQL database
        initializePGDB()
          .then((success: any) => {
            if (success) {
              // Set global flag that PostgreSQL is available
              pgAvailable = true;
              // Register PostgreSQL routes for chat functionality
              // '/api/pg/pods' is deliberately NOT mounted. It exposed an
              // unauthorized shadow copy of the pod API: getAllPods returned
              // every pod on the instance with no membership filter, joinPod
              // had no join-policy check at all (a non-member could join a
              // private pod and get a 200), and deletePod gated on a
              // created_by value that the sync path let a requester claim.
              // It had zero callers anywhere in the repo — the frontend uses
              // /api/pods, and only /api/pg/messages + /api/pg/status are live
              // (ChatRoom, SocketContext). Removed rather than patched.
              app.use('/api/pg/messages', pgMessageRoutes);
              app.use('/api/pg/status', pgStatusRoutes);
              console.log(
                'PostgreSQL routes registered for chat functionality',
              );
              // Kick off the daily 30-day message retention cron. Kept out
              // of schedulerService.ts on purpose so other tracks can edit
              // that file without stomping on this cron.
              if (process.env.NODE_ENV !== 'test') {
                try {
                  const { initPgRetention } = require('./services/pgRetentionService');
                  initPgRetention();
                } catch (retentionErr: any) {
                  console.error(
                    '[pg-retention] failed to initialize:',
                    retentionErr?.message || retentionErr,
                  );
                }
                try {
                  require('./services/agentInstallationCleanupService').initInstallationCleanup();
                } catch (cleanupErr: any) {
                  console.error(
                    '[installation-cleanup] failed to initialize:',
                    cleanupErr?.message || cleanupErr,
                  );
                }
              }
            } else {
              pgAvailable = false;
              console.warn(
                'PostgreSQL database initialization failed, chat functionality will use MongoDB',
              );
              // Register a dummy status endpoint to indicate PostgreSQL is not available
              app.use('/api/pg/status', (req: any, res: any) => {
                res.json({ available: false });
              });
            }
          })
          .catch((err: any) => {
            pgAvailable = false;
            console.error('Error initializing PostgreSQL database:', err);
            // Register a dummy status endpoint to indicate PostgreSQL is not available
            app.use('/api/pg/status', (req: any, res: any) => {
              res.json({ available: false });
            });
          });
      } else {
        pgAvailable = false;
        console.warn(
          'PostgreSQL connection failed, chat functionality will use MongoDB',
        );
        // Register a dummy status endpoint to indicate PostgreSQL is not available
        app.use('/api/pg/status', (req: any, res: any) => {
          res.json({ available: false });
        });
      }
    })
    .catch((err: any) => {
      pgAvailable = false;
      console.error('Error connecting to PostgreSQL:', err);
      // Register a dummy status endpoint to indicate PostgreSQL is not available
      app.use('/api/pg/status', (req: any, res: any) => {
        res.json({ available: false });
      });
    });
} else {
  pgAvailable = false;
  console.log(
    'PostgreSQL connection not configured. Chat functionality will use MongoDB.',
  );
  // Register a dummy status endpoint to indicate PostgreSQL is not available
  app.use('/api/pg/status', (req: any, res: any) => {
    res.json({ available: false });
  });
}

// Sentry's Express error handler must be registered after application routes.
// It is a no-op when SENTRY_DSN was absent during process startup.
attachSentryErrorHandler(app);

// Socket.io middleware for authentication
io.use((socket: any, next: any) => {
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
  } catch (err: any) {
    console.error('Socket auth error:', err.message);
    return next(new Error('Authentication error: Invalid token'));
  }
});

const emitPresence = async (podId: any) => {
  if (!podId) return;
  try {
    const sockets = await io.in(`pod_${podId}`).fetchSockets();
    const userIds = Array.from(
      new Set(
        sockets
          .map((s: any) => s.userId)
          .filter((userId: any) => userId),
      ),
    );
    io.to(`pod_${podId}`).emit('podPresence', { podId, userIds });
  } catch (error: any) {
    console.warn('Failed to emit pod presence:', error.message);
  }
};

const isPodMember = (pod: any, userId: any) => {
  if (!pod || !userId) {
    return false;
  }

  return (pod.members || []).some((member: any) => member?.toString() === userId.toString());
};

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const DMServiceForSocketAuth = require('./services/dmService');

const authorizeSocketPodAccess = async (socket: any, podId: any, action: any) => {
  if (!podId) {
    console.warn(`Socket tried to ${action} without podId`);
    socket.emit('error', { message: 'Pod ID is required' });
    return null;
  }

  const pod = await Pod.findById(podId);
  if (!pod) {
    console.error(`Socket error: Pod not found during ${action}`, { podId });
    socket.emit('error', { message: 'Pod not found' });
    return null;
  }

  // Read paths (join, listen for newMessage / typing) accept the §3.7
  // co-pod-member rule for `agent-dm` pods: a viewer who shares any pod
  // with either bot member can join the room and observe. Write paths
  // (post) check membership separately upstream — only members can
  // post, regardless of pod type.
  const isReadAction = action === 'join';
  const allowed = isReadAction
    ? await DMServiceForSocketAuth.canViewPod(socket.userId, pod)
    : isPodMember(pod, socket.userId);

  if (!allowed) {
    console.error(`Socket error: Not authorized to ${action} for this pod`, {
      podId,
      userId: socket.userId,
    });
    socket.emit('error', {
      message: `Not authorized to ${action} for this pod`,
    });
    return null;
  }

  return pod;
};

// Socket.io event handlers
io.on('connection', (socket: any) => {
  console.log(
    `New client connected (id: ${socket.id}, user: ${socket.userId})`,
  );
  socket.data.joinedPods = new Set();

  // Join a pod room
  socket.on('joinPod', async (podId: any) => {
    const pod = await authorizeSocketPodAccess(socket, podId, 'join');
    if (!pod) {
      return;
    }

    socket.join(`pod_${podId}`);
    socket.data.joinedPods.add(podId);
    console.log(`User ${socket.userId} joined pod room: pod_${pod.id || podId}`);
    await emitPresence(podId);
  });

  // Leave a pod room
  socket.on('leavePod', async (podId: any) => {
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
    async ({ podId, content, userId, messageType = 'text', replyToMessageId = null }: { podId: any; content: any; userId: any; messageType?: any; replyToMessageId?: any }) => {
      try {
        const socketUserId = socket.userId;

        // Validate required parameters - content must be present
        if (!podId || !content || !socketUserId) {
          console.error(
            'Socket error: Missing required parameters for sendMessage',
            { podId, userId: socketUserId },
          );
          socket.emit('error', { message: 'Missing required parameters' });
          return;
        }

        if (userId && userId !== socketUserId) {
          console.error('Socket error: User ID mismatch for sendMessage', {
            podId,
            userId,
            socketUserId,
          });
          socket.emit('error', {
            message: 'Not authorized to send messages for another user',
          });
          return;
        }

        console.log('Socket sendMessage received:', {
          podId,
          content,
          userId: socketUserId,
          messageType,
        });

        let message;
        const podInstance = await authorizeSocketPodAccess(socket, podId, 'post');
        if (!podInstance) {
          return;
        }

        // Use PostgreSQL for messages if available, otherwise fallback to MongoDB
        if (pgAvailable) {
          try {
            // Create message in PostgreSQL
            console.log('Creating message in PostgreSQL:', {
              podId,
              userId: socketUserId,
              content,
              messageType,
            });
            const newMessage = await PGMessage.create(
              podId,
              socketUserId,
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
              const user = await User.findById(socketUserId);
              const newMessage = new Message({
                podId,
                userId: socketUserId,
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
            const user = await User.findById(socketUserId);
            const newMessage = new Message({
              podId,
              userId: socketUserId,
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
            userId: socketUserId,
            username: mentionUsername,
          });
          if (podInstance.type === 'agent-admin') {
            await AgentMentionService.enqueueDmEvent({
              podId,
              message: formattedMessage,
              userId: socketUserId,
              username: mentionUsername,
            });
          }
        } catch (mentionError: any) {
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
      } catch (err: any) {
        console.error('Socket error:', err.message, { podId, userId: socket.userId });
        socket.emit('error', { message: 'Server error' });
      }
    },
  );

  // Disconnect event
  socket.on('disconnect', (reason: any) => {
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

module.exports = {
  app,
  server,
  isPodMember,
  authorizeSocketPodAccess,
};
