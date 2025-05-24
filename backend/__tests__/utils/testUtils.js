const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { newDb } = require('pg-mem');
const jwt = require('jsonwebtoken');

// MongoDB in-memory setup
let mongoServer;

const setupMongoDb = async () => {
  try {
    // Use the simplified API for v7+
    mongoServer = await MongoMemoryServer.create({
      binary: {
        skipMD5: true,
      },
      instance: {
        dbName: 'jest-test-db',
      },
    });

    const mongoUri = mongoServer.getUri();

    await mongoose.connect(mongoUri);
    console.log('Connected to in-memory MongoDB');
  } catch (error) {
    console.error('Error setting up in-memory MongoDB:', error);
    throw error;
  }
};

const closeMongoDb = async () => {
  try {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
    }
    console.log('In-memory MongoDB stopped');
  } catch (error) {
    console.error('Error stopping in-memory MongoDB:', error);
    throw error;
  }
};

const clearMongoDb = async () => {
  try {
    const { collections } = mongoose.connection;
    const collectionNames = Object.keys(collections);

    await Promise.all(collectionNames.map(async (key) => {
      const collection = collections[key];
      await collection.deleteMany({});
    }));
  } catch (error) {
    console.error('Error clearing MongoDB data:', error);
    throw error;
  }
};

// PostgreSQL in-memory setup
let pgDb;
let pgPool;

const setupPgDb = async () => {
  try {
    pgDb = newDb();

    // Enable UUID extension
    pgDb.public.registerFunction({
      name: 'gen_random_uuid',
      implementation: () => require('crypto').randomUUID(),
    });

    // Connect to the in-memory PostgreSQL
    pgPool = pgDb.adapters.createPg().pool();

    // Create tables - modify this based on your schema
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS pods (
        id VARCHAR(24) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        type VARCHAR(50) NOT NULL,
        created_by VARCHAR(24) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS pod_members (
        pod_id VARCHAR(24) NOT NULL,
        user_id VARCHAR(24) NOT NULL,
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (pod_id, user_id)
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(24) PRIMARY KEY,
        pod_id VARCHAR(24) NOT NULL,
        user_id VARCHAR(24) NOT NULL,
        content TEXT NOT NULL,
        message_type VARCHAR(50) DEFAULT 'text',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Connected to in-memory PostgreSQL');

    return pgPool;
  } catch (error) {
    console.error('Error setting up in-memory PostgreSQL:', error);
    throw error;
  }
};

const clearPgDb = async () => {
  try {
    if (pgPool) {
      await pgPool.query('DELETE FROM messages');
      await pgPool.query('DELETE FROM pod_members');
      await pgPool.query('DELETE FROM pods');
    }
  } catch (error) {
    console.error('Error clearing PostgreSQL data:', error);
    throw error;
  }
};

const closePgDb = async () => {
  try {
    if (pgPool) {
      await pgPool.end();
      console.log('In-memory PostgreSQL stopped');
    }
  } catch (error) {
    console.error('Error stopping in-memory PostgreSQL:', error);
    throw error;
  }
};

// JWT utilities
const generateTestToken = (userId) => jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });

// Test data generation
const createTestUser = async (User, override = {}) => {
  const defaultUser = {
    username: 'testuser',
    email: 'test@example.com',
    password: 'Password123!',
    ...override,
  };

  const user = new User(defaultUser);
  await user.save();
  return user;
};

const createTestPod = async (Pod, userId, override = {}) => {
  const defaultPod = {
    name: 'Test Pod',
    description: 'Test pod description',
    type: 'chat',
    createdBy: userId,
    members: [userId],
    ...override,
  };

  const pod = new Pod(defaultPod);
  await pod.save();
  return pod;
};

const createTestMessage = async (Message, podId, userId, override = {}) => {
  const defaultMessage = {
    podId,
    userId,
    content: 'Test message content',
    messageType: 'text',
    ...override,
  };

  const message = new Message(defaultMessage);
  await message.save();
  return message;
};

module.exports = {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  setupPgDb,
  clearPgDb,
  closePgDb,
  generateTestToken,
  createTestUser,
  createTestPod,
  createTestMessage,
};
