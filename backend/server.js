const express = require('express');
const connectDB = require('./config/db');
const { connectPG } = require('./config/db-pg');
const initializePGDB = require('./config/init-pg-db');
const authRoutes = require('./routes/auth');
const postRoutes = require('./routes/posts');
const userRoutes = require('./routes/users');
const podRoutes = require('./routes/pods');
const messageRoutes = require('./routes/messages');
const cors = require('cors');

// Conditionally load PostgreSQL routes
let pgPodRoutes, pgMessageRoutes, pgStatusRoutes;
if (process.env.PG_HOST) {
  pgPodRoutes = require('./routes/pg-pods');
  pgMessageRoutes = require('./routes/pg-messages');
  pgStatusRoutes = require('./routes/pg-status');
}

const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Authorization", "Content-Type"]
    },
    transports: ['websocket', 'polling']
});
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-auth-token']
}));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pods', podRoutes);
app.use('/api/messages', messageRoutes);

// Connect to MongoDB (for posts and user data)
connectDB();

// Connect to PostgreSQL if configured (for chat functionality)
if (process.env.PG_HOST) {
  console.log('Attempting to connect to PostgreSQL for chat functionality...');
  connectPG().then((pool) => {
    if (pool) {
      // Initialize PostgreSQL database
      initializePGDB().then(success => {
        if (success) {
          // Register PostgreSQL routes for chat functionality
          app.use('/api/pg/pods', pgPodRoutes);
          app.use('/api/pg/messages', pgMessageRoutes);
          app.use('/api/pg/status', pgStatusRoutes);
          console.log('PostgreSQL routes registered for chat functionality');
        } else {
          console.warn('PostgreSQL database initialization failed, chat functionality will use MongoDB');
          // Register a dummy status endpoint to indicate PostgreSQL is not available
          app.use('/api/pg/status', (req, res) => {
            res.json({ available: false });
          });
        }
      }).catch(err => {
        console.error('Error initializing PostgreSQL database:', err);
        // Register a dummy status endpoint to indicate PostgreSQL is not available
        app.use('/api/pg/status', (req, res) => {
          res.json({ available: false });
        });
      });
    } else {
      console.warn('PostgreSQL connection failed, chat functionality will use MongoDB');
      // Register a dummy status endpoint to indicate PostgreSQL is not available
      app.use('/api/pg/status', (req, res) => {
        res.json({ available: false });
      });
    }
  }).catch(err => {
    console.error('Error connecting to PostgreSQL:', err);
    // Register a dummy status endpoint to indicate PostgreSQL is not available
    app.use('/api/pg/status', (req, res) => {
      res.json({ available: false });
    });
  });
} else {
  console.log('PostgreSQL connection not configured. Chat functionality will use MongoDB.');
  // Register a dummy status endpoint to indicate PostgreSQL is not available
  app.use('/api/pg/status', (req, res) => {
    res.json({ available: false });
  });
}

// Socket.io middleware for authentication
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
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
        next();
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
  socket.on('sendMessage', async ({ podId, content, userId }) => {
    try {
      // Validate required parameters
      if (!podId || !content || !userId) {
        console.error('Socket error: Missing required parameters for sendMessage', { podId, userId });
        socket.emit('error', { message: 'Missing required parameters' });
        return;
      }
      
      // Use PostgreSQL for chat if available
      const isPG = process.env.PG_HOST;
      
      let message;
      
      if (isPG) {
        const PGMessage = require('./models/pg/Message');
        const PGPod = require('./models/pg/Pod');
        
        // Check if pod exists and user is a member
        const pod = await PGPod.findById(podId);
        if (!pod) {
          console.error('Socket error: Pod not found', { podId });
          socket.emit('error', { message: 'Pod not found' });
          return;
        }
        
        const isMember = await PGPod.isMember(podId, userId);
        if (!isMember) {
          console.error('Socket error: Not authorized to post in this pod', { podId, userId });
          socket.emit('error', { message: 'Not authorized to post in this pod' });
          return;
        }
        
        // Create message in PostgreSQL
        const newMessage = await PGMessage.create(podId, userId, content);
        message = await PGMessage.findById(newMessage.id);
      } else {
        const Message = require('./models/Message');
        const Pod = require('./models/Pod');
        const User = require('./models/User');
        
        // Check if pod exists and user is a member
        const pod = await Pod.findById(podId);
        if (!pod) {
          socket.emit('error', { message: 'Pod not found' });
          return;
        }
        
        if (!pod.members.includes(userId)) {
          socket.emit('error', { message: 'Not authorized to post in this pod' });
          return;
        }
        
        // Create message in MongoDB
        const user = await User.findById(userId);
        const newMessage = new Message({
          podId,
          userId,
          content
        });
        
        await newMessage.save();
        
        // Populate user info
        message = {
          ...newMessage.toObject(),
          username: user.username,
          profilePicture: user.profilePicture
        };
      }
      
      // Broadcast message to all users in the pod room
      io.to(`pod_${podId}`).emit('newMessage', message);
      
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
