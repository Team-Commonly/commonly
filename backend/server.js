const express = require('express');
const cors = require('cors');
const _path = require('path');
const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const connectDB = require('./config/db');
const connectPG = require('./config/db-pg');
const initializePGDB = require('./config/init-pg-db');
const authRoutes = require('./routes/auth');
const postRoutes = require('./routes/posts');
const userRoutes = require('./routes/users');
const podRoutes = require('./routes/pods');
const messageRoutes = require('./routes/messages');
const uploadsRoutes = require('./routes/uploads');
// Conditionally load PostgreSQL routes and models
let pgPodRoutes;
let pgMessageRoutes;
let pgStatusRoutes;
let PGMessage;
let PGPod;
const Message = require('./models/Message');
const Pod = require('./models/Pod');
const User = require('./models/User');

// Global flag to track PostgreSQL availability
let pgAvailable = false;

if (process.env.PG_HOST) {
  pgPodRoutes = require('./routes/pg-pods');
  pgMessageRoutes = require('./routes/pg-messages');
  pgStatusRoutes = require('./routes/pg-status');
  PGMessage = require('./models/pg/Message');
  PGPod = require('./models/pg/Pod');
}

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type'],
  },
  transports: ['websocket', 'polling'],
});
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token'],
}));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/uploads', uploadsRoutes);

// Connect to MongoDB (for posts and user data)
connectDB();

// Connect to PostgreSQL if configured (for chat functionality)
if (process.env.PG_HOST) {
  console.log('Attempting to connect to PostgreSQL for chat functionality...');
  connectPG().then((pgPool) => {
    if (pgPool) {
      // Initialize PostgreSQL database
      initializePGDB().then((success) => {
        if (success) {
          // Set global flag that PostgreSQL is available
          pgAvailable = true;
          // Register PostgreSQL routes for chat functionality
          app.use('/api/pg/pods', pgPodRoutes);
          app.use('/api/pg/messages', pgMessageRoutes);
          app.use('/api/pg/status', pgStatusRoutes);
          console.log('PostgreSQL routes registered for chat functionality');
        } else {
          pgAvailable = false;
          console.warn('PostgreSQL database initialization failed, chat functionality will use MongoDB');
          // Register a dummy status endpoint to indicate PostgreSQL is not available
          app.use('/api/pg/status', (req, res) => {
            res.json({ available: false });
          });
        }
      }).catch((err) => {
        pgAvailable = false;
        console.error('Error initializing PostgreSQL database:', err);
        // Register a dummy status endpoint to indicate PostgreSQL is not available
        app.use('/api/pg/status', (req, res) => {
          res.json({ available: false });
        });
      });
    } else {
      pgAvailable = false;
      console.warn('PostgreSQL connection failed, chat functionality will use MongoDB');
      // Register a dummy status endpoint to indicate PostgreSQL is not available
      app.use('/api/pg/status', (req, res) => {
        res.json({ available: false });
      });
    }
  }).catch((err) => {
    pgAvailable = false;
    console.error('Error connecting to PostgreSQL:', err);
    // Register a dummy status endpoint to indicate PostgreSQL is not available
    app.use('/api/pg/status', (req, res) => {
      res.json({ available: false });
    });
  });
} else {
  pgAvailable = false;
  console.log('PostgreSQL connection not configured. Chat functionality will use MongoDB.');
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

// Socket.io event handlers
io.on('connection', (socket) => {
  console.log(`New client connected (id: ${socket.id}, user: ${socket.userId})`);

  // Join a pod room
  socket.on('joinPod', (podId) => {
    if (!podId) {
      console.warn('Socket tried to join pod without podId');
      return;
    }
    socket.join(`pod_${podId}`);
    console.log(`User ${socket.userId} joined pod room: pod_${podId}`);
  });

  // Leave a pod room
  socket.on('leavePod', (podId) => {
    if (!podId) {
      console.warn('Socket tried to leave pod without podId');
      return;
    }
    socket.leave(`pod_${podId}`);
    console.log(`User ${socket.userId} left pod room: pod_${podId}`);
  });

  // Send a message to a pod
  socket.on('sendMessage', async ({ podId, content, userId, messageType = 'text' }) => {
    try {
      // Validate required parameters - content must be present
      if (!podId || !content || !userId) {
        console.error('Socket error: Missing required parameters for sendMessage', { podId, userId });
        socket.emit('error', { message: 'Missing required parameters' });
        return;
      }

      console.log('Socket sendMessage received:', { podId, content, userId, messageType });

      let message;
      let podInstance;

      // Use the global pgAvailable flag instead of checking process.env.PG_HOST
      if (pgAvailable) {
        try {
          // Check if pod exists and user is a member
          podInstance = await PGPod.findById(podId);
          if (!podInstance) {
            console.error('Socket error: Pod not found', { podId });
            socket.emit('error', { message: 'Pod not found' });
            return;
          }

          // Check membership
          const isMember = await PGPod.isMember(podId, userId);
          if (!isMember) {
            console.error('Socket error: Not authorized to post in this pod', { podId, userId });
            socket.emit('error', { message: 'Not authorized to post in this pod' });
            return;
          }

          // Create message in PostgreSQL
          console.log('Creating message in PostgreSQL:', { podId, userId, content, messageType });
          const newMessage = await PGMessage.create(podId, userId, content, messageType);
          console.log('Message created successfully:', newMessage);

          message = await PGMessage.findById(newMessage.id);
          console.log('Message retrieved for broadcast:', message);
        } catch (dbError) {
          console.error('Database error with PostgreSQL, falling back to MongoDB:', dbError);
          try {
            // Check if pod exists and user is a member
            podInstance = await Pod.findById(podId);
            if (!podInstance) {
              socket.emit('error', { message: 'Pod not found' });
              return;
            }

            if (!podInstance.members.includes(userId)) {
              socket.emit('error', { message: 'Not authorized to post in this pod' });
              return;
            }

            // Create message in MongoDB
            const user = await User.findById(userId);
            const newMessage = new Message({
              podId,
              userId,
              content,
              messageType,
            });

            await newMessage.save();
            console.log('Message saved to MongoDB after PG fallback:', newMessage._id);

            // Populate user info
            message = {
              ...newMessage.toObject(),
              username: user.username,
              profilePicture: user.profilePicture,
            };
          } catch (mongoDbError) {
            console.error('Failed to save message in MongoDB fallback:', mongoDbError);
            socket.emit('error', { message: 'Failed to save message to any database' });
            return;
          }
        }
      } else {
        console.log('Using MongoDB for messages (PostgreSQL not available)');
        // Check if pod exists and user is a member
        podInstance = await Pod.findById(podId);
        if (!podInstance) {
          socket.emit('error', { message: 'Pod not found' });
          return;
        }

        if (!podInstance.members.includes(userId)) {
          socket.emit('error', { message: 'Not authorized to post in this pod' });
          return;
        }

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
          console.error('Database error creating message in MongoDB:', dbError);
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

        // Ensure all other fields
        ...message,
      };

      // If we have user data, standardize the userId field
      if (typeof message.userId !== 'object' && message.username) {
        // User data is separate, not an object
        formattedMessage.user_id = message.userId || message.user_id;
        formattedMessage.username = message.username;
        formattedMessage.profile_picture = message.profile_picture;

        // Create an object format too for compatibility
        formattedMessage.userId = {
          _id: message.userId || message.user_id,
          username: message.username,
          profilePicture: message.profile_picture,
        };
      }

      // Log the formatted message for debugging
      console.log('Broadcasting formatted message:', {
        id: formattedMessage._id,
        content: formattedMessage.content,
        userId: formattedMessage.userId,
        username: formattedMessage.username,
      });

      io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
    } catch (err) {
      console.error('Socket error:', err.message, { podId, userId });
      socket.emit('error', { message: 'Server error' });
    }
  });

  // Disconnect event
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected (id: ${socket.id}, user: ${socket.userId}). Reason: ${reason}`);
  });

  // Send a welcome message to confirm connection
  socket.emit('welcome', { message: 'Connected to chat server successfully' });
});

// Start the server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
