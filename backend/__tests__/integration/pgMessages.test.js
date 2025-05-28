const request = require('supertest');
const express = require('express');
const { newDb } = require('pg-mem');
const { generateTestToken } = require('../utils/testUtils');

// Mock the PostgreSQL pool with pg-mem
jest.mock('../../config/db-pg', () => {
  const { newDb } = require('pg-mem');
  const mockDb = newDb();
  mockDb.public.registerFunction({
    name: 'gen_random_uuid',
    implementation: () => require('crypto').randomUUID(),
  });
  const { Pool } = mockDb.adapters.createPg();
  const pool = new Pool();
  return {
    pool,
    connectPG: async () => pool,
  };
});

const { pool: pgPool } = require('../../config/db-pg');

const pgMessageRoutes = require('../../routes/pg-messages');
const PGPod = require('../../models/pg/Pod');

let app;

beforeAll(async () => {
  // Create required tables
  await pgPool.query(`
    CREATE TABLE pods (
      id VARCHAR(24) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      type VARCHAR(50) NOT NULL,
      created_by VARCHAR(24) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pgPool.query(`
    CREATE TABLE pod_members (
      pod_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pod_id, user_id)
    );
  `);
  await pgPool.query(`
    CREATE TABLE messages (
      id SERIAL PRIMARY KEY,
      pod_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      content TEXT NOT NULL,
      message_type VARCHAR(20) DEFAULT 'text',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pgPool.query(`
    CREATE TABLE users (
      _id VARCHAR(24) PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      profile_picture TEXT
    );
  `);

  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use('/api/pg/messages', pgMessageRoutes);

  // Mock PGPod methods that rely on unsupported SQL features in pg-mem
  jest.spyOn(PGPod, 'findById').mockImplementation(async (id) => {
    const podRes = await pgPool.query('SELECT * FROM pods WHERE id = $1', [id]);
    if (!podRes.rows.length) return null;
    const membersRes = await pgPool.query('SELECT user_id FROM pod_members WHERE pod_id = $1', [id]);
    return { ...podRes.rows[0], members: membersRes.rows.map((m) => m.user_id) };
  });
  jest.spyOn(PGPod, 'isMember').mockImplementation(async (podId, userId) => {
    const res = await pgPool.query('SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2', [podId, userId]);
    return res.rows.length > 0;
  });
});

afterEach(async () => {
  await pgPool.query('DELETE FROM messages');
  await pgPool.query('DELETE FROM pod_members');
  await pgPool.query('DELETE FROM pods');
  await pgPool.query('DELETE FROM users');
});

afterAll(async () => {
  await pgPool.end();
});

const createUser = async (id, username) => {
  await pgPool.query('INSERT INTO users (_id, username) VALUES ($1, $2)', [id, username]);
};

const createPod = async (userId, name = 'Pod 1') => {
  const podId = Math.random().toString(16).slice(2, 10);
  await pgPool.query(
    'INSERT INTO pods (id, name, description, type, created_by) VALUES ($1, $2, $3, $4, $5)',
    [podId, name, 'Test', 'chat', userId],
  );
  await pgPool.query('INSERT INTO pod_members (pod_id, user_id) VALUES ($1, $2)', [podId, userId]);
  return podId;
};

describe('PostgreSQL Message Routes', () => {
  test('should create and fetch messages', async () => {
    const userId = 'user1';
    await createUser(userId, 'User1');
    const token = generateTestToken(userId);
    const podId = await createPod(userId);

    const createRes = await request(app)
      .post(`/api/pg/messages/${podId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'hello pg' })
      .expect(200);
    expect(createRes.body.content).toBe('hello pg');

    const getRes = await request(app)
      .get(`/api/pg/messages/${podId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.length).toBe(1);
    expect(getRes.body[0].content).toBe('hello pg');
  });

  test('should not allow non-members to create messages', async () => {
    const ownerId = 'owner';
    const otherId = 'outsider';
    await createUser(ownerId, 'Owner');
    await createUser(otherId, 'Other');
    const ownerToken = generateTestToken(ownerId);
    const otherToken = generateTestToken(otherId);
    const podId = await createPod(ownerId);

    await request(app)
      .post(`/api/pg/messages/${podId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ content: 'nope' })
      .expect(401);
  });
});
