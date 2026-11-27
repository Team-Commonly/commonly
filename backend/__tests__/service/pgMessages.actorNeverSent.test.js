// F655: the owner and on-behalf-of ids stored on an agent's message never
// leave the server. Route level: an edit and a delete through the HTTP routes,
// on the shipped model SQL (pg-mem with migration 0030), answer without either
// column or either id.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../config/db-pg', () => ({ pool: mockPool }));

// The auth middleware loads the caller; a live, un-banned row keeps it on
// its happy path.
jest.mock('../../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ banned: false }) }) })),
}));
jest.mock('../../models/Pod', () => ({ findById: jest.fn() }));

const PGMessage = require('../../models/pg/Message');
const pgMessageRoutes = require('../../routes/pg-messages');
const { generateTestToken } = require('../utils/testUtils');

const POD = 'pod-1';
const AGENT = 'agent-1';
const OWNER = '64b000000000000000000001';
const ASKER = '64b000000000000000000002';
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0030_message_actor.sql'), 'utf8');

const expectNoActor = (body) => {
  const text = JSON.stringify(body);
  expect(text).not.toContain('owner_user_id');
  expect(text).not.toContain('on_behalf_of_user_id');
  expect(text).not.toContain(OWNER);
  expect(text).not.toContain(ASKER);
};

let app;
let token;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  await mockPool.query(`CREATE TABLE users (
    _id VARCHAR(255) PRIMARY KEY, username VARCHAR(255), profile_picture TEXT, is_bot BOOLEAN
  )`);
  await mockPool.query(`CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    legacy_mongo_id VARCHAR(24),
    pod_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    content TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    author_kind VARCHAR(20),
    summary TEXT,
    kind VARCHAR(20),
    receipt JSONB,
    payload JSONB,
    top_level_answer BOOLEAN,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  )`);
  await mockPool.query(MIGRATION);
  await mockPool.query('CREATE TABLE pods (id VARCHAR(255) PRIMARY KEY, updated_at TIMESTAMP WITH TIME ZONE)');
  await mockPool.query(`INSERT INTO pods (id) VALUES ('${POD}')`);
  await mockPool.query(`INSERT INTO users (_id, username, is_bot) VALUES ('${AGENT}', 'nova', true)`);
  app = express();
  app.use(express.json());
  app.use('/api/pg/messages', pgMessageRoutes);
  token = generateTestToken(AGENT);
});

const agentMessage = async () => {
  const row = await PGMessage.create(
    POD, AGENT, 'Done: the redirect is fixed.', 'text', null, null, null, null, null, null, false, null,
    { ownerUserId: OWNER, onBehalfOfUserId: ASKER },
  );
  const stored = (await mockPool.query(
    'SELECT owner_user_id, on_behalf_of_user_id FROM messages WHERE id = $1', [Number(row.id)],
  )).rows[0];
  // The row really carries both, so a leak would show.
  expect(stored).toEqual({ owner_user_id: OWNER, on_behalf_of_user_id: ASKER });
  return row;
};

describe('the message actor never leaves the server through a route (F655)', () => {
  it('an edit answers without the actor columns', async () => {
    const row = await agentMessage();
    const res = await request(app)
      .put(`/api/pg/messages/${row.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Done: the redirect is fixed, and tested.' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Done: the redirect is fixed, and tested.');
    expectNoActor(res.body);
  });

  it('a delete answers without the actor columns', async () => {
    const row = await agentMessage();
    const res = await request(app)
      .delete(`/api/pg/messages/${row.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expectNoActor(res.body);
    expect((await mockPool.query('SELECT id FROM messages WHERE id = $1', [Number(row.id)])).rows).toHaveLength(0);
  });
});
