// Real Mongo workspace + real pgPodSyncService/PGPod writes into pg-mem.
// Stop at Scout's post boundary and enforce the same pod FK on its first
// message. No model, email or external runtime is involved.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 'token'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('../../../models/Task', () => ({ create: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { findOneAndUpdate: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../../services/communityPodService', () => ({ ensureUserInCommunityPod: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../../../config/db-pg', () => ({ pool: { query: (...args) => mockQuery(...args) } }));
const mockPost = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({ postMessage: (...args) => mockPost(...args) }));
jest.mock('../../../services/nativeRuntimeService', () => ({ hostedEngineAvailable: () => false }));
jest.mock('../../../services/hostedRuntimeService', () => ({ hostedCapsForOwner: jest.fn() }));
jest.mock('../../../services/welcomeHostedStart', () => ({ WELCOME_HOSTED_ACTION: 'start' }));
const mockSyncUser = jest.fn();
const mockScoutUser = jest.fn();
jest.mock('../../../services/agentIdentityService', () => ({
  syncUserToPostgreSQL: (...args) => mockSyncUser(...args),
  getOrCreateAgentUser: (...args) => mockScoutUser(...args),
}));
const { newDb } = require('pg-mem');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { createDefaultWorkspacePod } = require('../../../controllers/authController');

describe('signup workspace exists in PG before Scout posts', () => {
  const oldPg = process.env.PG_HOST;
  let pool;
  beforeAll(async () => {
    await setupMongoDb();
    process.env.PG_HOST = 'test-memory';
    pool = new (newDb().adapters.createPg().Pool)();
    await pool.query(`
      CREATE TABLE users (_id text PRIMARY KEY);
      CREATE TABLE pods (id text PRIMARY KEY, name text, description text, type text, created_by text REFERENCES users(_id), updated_at timestamptz DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE pod_members (pod_id text REFERENCES pods(id), user_id text REFERENCES users(_id), PRIMARY KEY(pod_id,user_id));
      CREATE TABLE messages (pod_id text REFERENCES pods(id), content text);
    `);
    mockQuery.mockImplementation((...args) => pool.query(...args));
  });
  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
    await pool.end();
    if (oldPg === undefined) delete process.env.PG_HOST; else process.env.PG_HOST = oldPg;
  });

  test('queued signup tail completes its real PG mirror before the first agent insert', async () => {
    const owner = { _id: new mongoose.Types.ObjectId(), username: 'new-signup', email: 'signup@example.test' };
    const scout = { _id: new mongoose.Types.ObjectId(), username: 'scout-fixture', isBot: true };
    await User.collection.insertMany([owner, scout]);
    // Hold the user mirror so a missing await cannot pass just because memory
    // databases happen to complete quickly.
    let release;
    const admitted = new Promise((resolve) => { release = resolve; });
    mockSyncUser.mockImplementation(async (user) => {
      await admitted;
      await pool.query('INSERT INTO users (_id) VALUES ($1)', [String(user._id)]);
    });
    let releasePod;
    let notifyPod;
    const podWriteAllowed = new Promise((resolve) => { releasePod = resolve; });
    const podWriteStarted = new Promise((resolve) => { notifyPod = resolve; });
    mockQuery.mockImplementation(async (sql, args) => {
      if (/INSERT INTO pods/.test(sql)) { notifyPod(); await podWriteAllowed; }
      return pool.query(sql, args);
    });
    mockScoutUser.mockResolvedValue(scout);
    jest.spyOn(Pod, 'updateOne').mockResolvedValue({ modifiedCount: 1 });
    let finish;
    const posted = new Promise((resolve) => { finish = resolve; });
    mockPost.mockImplementation(async ({ podId, content }) => {
      try {
        const result = await pool.query('INSERT INTO messages (pod_id, content) VALUES ($1, $2) RETURNING pod_id', [podId, content]);
        finish(result.rows[0]);
      } catch (error) { finish({ error: error.message }); throw error; }
    });
    await createDefaultWorkspacePod(String(owner._id));
    await new Promise((resolve) => setImmediate(resolve));
    const pod = await Pod.findOne({ createdBy: owner._id }).lean();
    expect(pod).not.toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
    release();
    await podWriteStarted;
    await new Promise((resolve) => setImmediate(resolve));
    // Even after the user sync completes, the delayed pod INSERT must be
    // awaited. Dropping just that await lets Scout hit the FK too early.
    const postedBeforePod = mockPost.mock.calls.length;
    releasePod();
    const first = await posted;
    expect(postedBeforePod).toBe(0);
    expect(first.pod_id).toBe(String(pod._id));
    const mirrored = await pool.query('SELECT created_by FROM pods WHERE id = $1', [String(pod._id)]);
    expect(mirrored.rows).toEqual([{ created_by: String(owner._id) }]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
