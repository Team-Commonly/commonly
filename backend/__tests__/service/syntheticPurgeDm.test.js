const mongoose = require('mongoose');
const { newDb } = require('pg-mem');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
let mockPool;
jest.mock('../../config/db-pg', () => ({ pool: { query: (...args) => mockPool.query(...args) } }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentCredential = require('../../models/AgentCredential');
const Message = require('../../models/Message');
const AgentMemory = require('../../models/AgentMemory');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { purgeSyntheticAccounts } = require('../../services/syntheticAccountPurgeService');
const id = () => new mongoose.Types.ObjectId();
const OLD = new Date('2026-10-15');
const NOW = new Date('2026-10-25');
const insertUser = async (fields) => { const row = { _id: id(), email: `${id()}@fixture.test`, createdAt: OLD, ...fields }; await User.collection.insertOne(row); return row; };

describe('Synthetic purge DM preservation', () => {
  let pool; let schema; let adminPool;
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    if (process.env.INTEGRATION_TEST === 'true') {
      const { Pool } = require('pg');
      const options = { host: process.env.PG_HOST, port: Number(process.env.PG_PORT), database: process.env.PG_DATABASE,
        user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: false };
      adminPool = new Pool(options);
      schema = `purge_dm_${id().toString()}`;
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ ...options, options: `-c search_path=${schema}` });
    } else {
      const Pool = newDb().adapters.createPg().Pool; pool = new Pool();
    }
    mockPool = pool;
    await pool.query('CREATE TABLE users (_id varchar(24) PRIMARY KEY)');
    await pool.query('CREATE TABLE pods (id varchar(24) PRIMARY KEY, type text)');
    await pool.query('CREATE TABLE pod_members (pod_id varchar(24) REFERENCES pods(id) ON DELETE CASCADE, user_id varchar(24))');
    await pool.query('CREATE TABLE messages (pod_id varchar(24))');
    await pool.query('CREATE TABLE message_claims (pod_id varchar(24))');
  });
  afterEach(async () => { await clearMongoDb(); await pool.end();
    if (adminPool) { await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); await adminPool.end(); adminPool = null; } });

  it.each(['agent-room', 'agent-dm'].flatMap((type) => [false, true].map((owned) => [type, owned])))
    ('retains both stores and independent agents in %s (created by synthetic=%s)', async (type, owned) => {
      const human = await insertUser({ username: 'eng-smoke-journey-1015124709', email: 'journey@ops.commonly.invalid', isBot: false });
      const agent = await insertUser({ username: 'independent', isBot: true });
      const other = await insertUser({ username: 'other', isBot: false });
      const pod = { _id: id(), name: 'Historical DM', type, createdBy: owned ? human._id : other._id, members: [human._id, agent._id] };
      const shared = { _id: id(), name: 'Shared', type: 'standard', createdBy: other._id, members: [human._id, other._id] };
      await Pod.collection.insertMany([pod, shared]);
      await Message.collection.insertOne({ podId: pod._id, userId: agent._id, content: 'Independent history' });
      await AgentMemory.collection.insertOne({ agentName: 'independent', instanceId: 'default' });
      await pool.query('INSERT INTO messages VALUES ($1)', [String(pod._id)]);
      for (const p of [pod, shared]) {
        await pool.query('INSERT INTO pods VALUES ($1,$2)', [String(p._id), p.type]);
        for (const m of p.members) await pool.query('INSERT INTO pod_members VALUES ($1,$2)', [String(p._id), String(m)]);
      }
      const own = await AgentInstallation.create({ agentName: 'independent', podId: pod._id, version: '1.0.0', installedBy: human._id });
      const keep = await AgentInstallation.create({ agentName: 'other-agent', podId: pod._id, version: '1.0.0', installedBy: other._id });
      const key = await AgentCredential.create({ tokenHash: 'owned', kind: 'runtime', ownerUserId: human._id, agentUserId: agent._id });
      const otherKey = await AgentCredential.create({ tokenHash: 'other', kind: 'runtime', ownerUserId: other._id, agentUserId: agent._id });
      const dry = await purgeSyntheticAccounts({ now: NOW, pool });
      expect(await User.findById(human._id)).not.toBeNull();
      expect((await AgentInstallation.findById(own._id)).status).toBe('active');
      expect((await AgentCredential.findById(key._id)).status).toBe('active');
      await purgeSyntheticAccounts({ apply: true, now: NOW, pool });
      const after = await Pod.findById(pod._id);
      const pair = pod.members.map(String).sort();
      expect(after?.members.map(String).sort()).toEqual(pair);
      const rows = (await pool.query('SELECT user_id FROM pod_members WHERE pod_id=$1', [String(pod._id)])).rows;
      expect(rows.map((r) => r.user_id).sort()).toEqual(pair);
      expect((await Pod.findById(shared._id)).members.map(String)).toEqual([String(other._id)]);
      expect((await pool.query('SELECT user_id FROM pod_members WHERE pod_id=$1', [String(shared._id)])).rows.map((r) => r.user_id)).toEqual([String(other._id)]);
      expect(await User.findById(human._id)).toBeNull();
      expect(await User.findById(agent._id)).not.toBeNull();
      expect(await Message.countDocuments({ podId: pod._id, content: 'Independent history' })).toBe(1);
      expect(await AgentMemory.countDocuments({ agentName: 'independent' })).toBe(1);
      expect((await pool.query('SELECT pod_id FROM messages WHERE pod_id=$1', [String(pod._id)])).rows).toHaveLength(1);
      expect((await AgentInstallation.findById(own._id)).status).toBe('paused');
      expect((await AgentInstallation.findById(keep._id)).status).toBe('active');
      expect((await AgentCredential.findById(key._id)).status).toBe('revoked');
      expect((await AgentCredential.findById(otherKey._id)).status).toBe('active');
      expect(dry.counts['agentinstallations.paused']).toBe(1);
      expect(dry.accounts[0].preservedDms).toEqual(owned ? [String(pod._id)] : []);
      const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await require('../../controllers/podController').getPodById({ params: { id: String(pod._id), type }, userId: String(agent._id) }, response);
      expect(response.status).not.toHaveBeenCalled();
      const projected = response.json.mock.calls[0][0];
      expect(projected.members.find((m) => String(m._id) === String(human._id)).username).toBe('Deleted user');
      expect(await require('../../services/dmService').canViewPod(String(agent._id), projected)).toBe(true);
      const context = await require('../../services/podContextService').getPodContext({ podId: String(pod._id), userId: String(agent._id), skillMode: 'none' });
      expect(context.members).toEqual(expect.arrayContaining([{ name: 'Deleted user', isAgent: false, self: false }]));
    });
  it('refuses to delete a disposable Scout that another DM depends on', async () => {
    const human = await insertUser({ username: 'eng-smoke-journey-1015124709', email: 'journey@ops.commonly.invalid', isBot: false });
    const instance = require('../../services/personaHireService').perUserInstanceId(String(human._id));
    const scout = await insertUser({ username: `scout-${instance}`, isBot: true });
    const other = await insertUser({ username: 'independent', isBot: true });
    const pod = { _id: id(), type: 'agent-dm', createdBy: other._id, members: [scout._id, other._id] };
    await Pod.collection.insertOne(pod);
    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool });
    expect(report.accounts[0].refused).toMatch(/agent participates in a DM/);
    expect(await User.findById(human._id)).not.toBeNull();
    expect(await User.findById(scout._id)).not.toBeNull();
    expect((await Pod.findById(pod._id)).members.map(String)).toEqual(pod.members.map(String));
  });

  it('deletes a DM wholly inside the disposable footprint', async () => {
    const human = await insertUser({ username: 'eng-smoke-journey-1015124709', email: 'journey@ops.commonly.invalid', isBot: false });
    const instance = require('../../services/personaHireService').perUserInstanceId(String(human._id));
    const scout = await insertUser({ username: `scout-${instance}`, isBot: true });
    const pod = { _id: id(), type: 'agent-room', createdBy: human._id, members: [human._id, scout._id] };
    await Pod.collection.insertOne(pod);
    await pool.query('INSERT INTO pods VALUES ($1,$2)', [String(pod._id), pod.type]);
    await pool.query('INSERT INTO pod_members VALUES ($1,$2)', [String(pod._id), String(human._id)]);
    await purgeSyntheticAccounts({ apply: true, now: NOW, pool });
    expect(await Pod.findById(pod._id)).toBeNull();
    // In default mode deletePodCascade intentionally has no configured PG mirror.
    if (process.env.INTEGRATION_TEST === 'true') {
      expect((await pool.query('SELECT id FROM pods')).rows).toHaveLength(0);
      expect((await pool.query('SELECT user_id FROM pod_members')).rows).toHaveLength(0);
    }
    expect(await User.findById(scout._id)).toBeNull();
  });

  it('still refuses a synthetic-created DM another human joined', async () => {
    const human = await insertUser({ username: 'eng-smoke-journey-1015124709', email: 'journey@ops.commonly.invalid', isBot: false });
    const other = await insertUser({ username: 'real', isBot: false });
    const pod = { _id: id(), type: 'agent-room', createdBy: human._id, members: [human._id, other._id] };
    await Pod.collection.insertOne(pod);
    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool });
    expect(report.accounts[0].refused).toMatch(/another human/);
    expect(await User.findById(human._id)).not.toBeNull();
    expect(await Pod.findById(pod._id)).not.toBeNull();
  });

  it('refuses to delete a disposable Scout installed by another owner', async () => {
    const human = await insertUser({ username: 'eng-smoke-journey-1015124709', email: 'journey@ops.commonly.invalid', isBot: false });
    const other = await insertUser({ username: 'real', isBot: false });
    const instanceId = require('../../services/personaHireService').perUserInstanceId(String(human._id));
    const scout = await insertUser({ username: `scout-${instanceId}`, isBot: true });
    const installation = await AgentInstallation.create({ agentName: 'scout', instanceId, podId: id(), version: '1.0.0', installedBy: other._id });
    const report = await purgeSyntheticAccounts({ apply: true, now: NOW, pool });
    expect(report.accounts[0].refused).toMatch(/Scout is installed by another user/);
    expect(await User.findById(human._id)).not.toBeNull();
    expect(await User.findById(scout._id)).not.toBeNull();
    expect((await AgentInstallation.findById(installation._id)).status).toBe('active');
  });

});
