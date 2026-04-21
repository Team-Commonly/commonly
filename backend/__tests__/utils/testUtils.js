const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { newDb } = require('pg-mem');
const jwt = require('jsonwebtoken');

const useRealServices = () => process.env.INTEGRATION_TEST === 'true';

// MongoDB setup — Tier 1 (real services) or Tier 0 (in-memory)
let mongoServer;

const setupMongoDb = async () => {
  try {
    if (useRealServices()) {
      const uri = process.env.MONGO_URI;
      if (!uri) throw new Error('INTEGRATION_TEST=true but MONGO_URI is not set');
      await mongoose.connect(uri);
      // Real Mongo is shared across test files in a single Jest --runInBand run;
      // drop the DB per-suite so each file starts with a clean slate and is
      // isolated from data seeded by prior files.
      await mongoose.connection.dropDatabase();
      console.log('[tier1] Connected to real MongoDB and dropped DB:', uri);
      return;
    }

    mongoServer = await MongoMemoryServer.create({
      binary: {
        version: '7.0.11',
        skipMD5: true,
      },
      instance: {
        dbName: 'jest-test-db',
      },
    });

    await mongoose.connect(mongoServer.getUri());
    console.log('Connected to in-memory MongoDB');
  } catch (error) {
    console.error('Error setting up MongoDB:', error);
    throw error;
  }
};

const closeMongoDb = async () => {
  try {
    await mongoose.disconnect();
    if (mongoServer) {
      await mongoServer.stop();
      mongoServer = undefined;
    }
    console.log(useRealServices() ? 'Real MongoDB disconnected' : 'In-memory MongoDB stopped');
  } catch (error) {
    console.error('Error stopping MongoDB:', error);
    throw error;
  }
};

const clearMongoDb = async () => {
  try {
    const { collections } = mongoose.connection;
    const collectionNames = Object.keys(collections);

    await Promise.all(
      collectionNames.map(async (key) => {
        const collection = collections[key];
        await collection.deleteMany({});
      }),
    );
  } catch (error) {
    console.error('Error clearing MongoDB data:', error);
    throw error;
  }
};

// PostgreSQL setup — Tier 1 (real services via schema.sql) or Tier 0 (pg-mem)
let pgDb;
let pgPool;

const setupPgDb = async () => {
  try {
    if (useRealServices()) {
      // eslint-disable-next-line global-require
      const { Pool } = require('pg');
      pgPool = new Pool({
        host: process.env.PG_HOST,
        port: Number(process.env.PG_PORT || 5432),
        database: process.env.PG_DATABASE,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        ssl: false,
      });
      await pgPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      const schemaPath = path.join(__dirname, '..', '..', 'config', 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pgPool.query(schema);
      // Same cross-file-contamination concern as Mongo: TRUNCATE on setup so
      // each suite starts with an empty schema.
      await pgPool.query('TRUNCATE TABLE messages, pod_members, pods, users RESTART IDENTITY CASCADE');
      console.log('[tier1] Connected to real Postgres, applied schema.sql, truncated tables');
      return pgPool;
    }

    pgDb = newDb();

    pgDb.public.registerFunction({
      name: 'gen_random_uuid',
      implementation: () => require('crypto').randomUUID(),
    });

    pgPool = pgDb.adapters.createPg().pool();

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
    console.error('Error setting up PostgreSQL:', error);
    throw error;
  }
};

const clearPgDb = async () => {
  try {
    if (!pgPool) return;
    // Real PG: TRUNCATE ... CASCADE handles FK ordering; pg-mem doesn't support TRUNCATE.
    if (useRealServices()) {
      await pgPool.query('TRUNCATE TABLE messages, pod_members, pods, users RESTART IDENTITY CASCADE');
    } else {
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
      pgPool = undefined;
      console.log(useRealServices() ? 'Real PostgreSQL disconnected' : 'In-memory PostgreSQL stopped');
    }
  } catch (error) {
    console.error('Error stopping PostgreSQL:', error);
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

// Combined teardown function
const teardownMongoDb = async (server) => {
  try {
    await clearMongoDb();
    await closeMongoDb();
  } catch (error) {
    console.error('Error during MongoDB teardown:', error);
  }
};

module.exports = {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
  teardownMongoDb,
  setupPgDb,
  clearPgDb,
  closePgDb,
  generateTestToken,
  createTestUser,
  createTestPod,
  createTestMessage,
};
