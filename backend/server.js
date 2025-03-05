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
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
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
        return next(new Error('Authentication error: Token not provided'));
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.user.id;
        next();
    } catch (err) {
        return next(new Error('Authentication error: Invalid token'));
    }
});

// Socket.io event handlers
io.on('connection', (socket) => {
  console.log('New client connected');
  
  // Join a pod room
  socket.on('joinPod', (podId) => {
    socket.join(`pod_${podId}`);
    console.log(`User joined pod room: pod_${podId}`);
  });
  
  // Leave a pod room
  socket.on('leavePod', (podId) => {
    socket.leave(`pod_${podId}`);
    console.log(`User left pod room: pod_${podId}`);
  });
  
  // Send a message to a pod
  socket.on('sendMessage', async ({ podId, content, userId }) => {
    try {
      // Use PostgreSQL for chat if available
      const isPG = process.env.PG_HOST;
      
      let message;
      
      if (isPG) {
        const PGMessage = require('./models/pg/Message');
        const PGPod = require('./models/pg/Pod');
        
        // Check if pod exists and user is a member
        const pod = await PGPod.findById(podId);
        if (!pod) {
          socket.emit('error', { message: 'Pod not found' });
          return;
        }
        
        const isMember = await PGPod.isMember(podId, userId);
        if (!isMember) {
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
      console.error('Socket error:', err.message);
      socket.emit('error', { message: 'Server error' });
    }
  });
  
  // Disconnect event
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start the server
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
