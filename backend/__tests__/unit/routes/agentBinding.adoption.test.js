// ADR-026 D3 invariants on mongodb-memory-server: adoption is a CAS
// (concurrent adopts produce exactly one winner and a clean 409), the
// bound-agent predicate comes from the daemon credential (never the body),
// ownership is enforced, and release is an explicit owner action.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => {
  const mw = (req, res, next) => { req.user = { id: global.__CALLER_ID }; next(); };
  mw.touchLastActive = jest.fn();
  return mw;
});

const { hash } = require('../../../utils/secret');

let mongod; let app; let AgentCredential; let User; let AgentInstallation;
const DAEMON_A = `cm_daemon_${'a'.repeat(32)}`;
const DAEMON_B = `cm_daemon_${'b'.repeat(32)}`;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentCredential = require('../../../models/AgentCredential');
  User = require('../../../models/User');
  AgentInstallation = require('../../../models/AgentRegistry').AgentInstallation;
  app = express();
  app.use(express.json());
  app.use('/api/agent-binding', require('../../../routes/agentBinding'));
});

afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let owner; let bot;
beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), AgentCredential.deleteMany({}), AgentInstallation.deleteMany({}),
  ]);
  owner = await User.create({ username: `o${Date.now() % 1e6}`, email: `o${Date.now()}@x.com`, password: 'x'.repeat(12) });
  global.__CALLER_ID = String(owner._id);
  bot = await User.create({
    username: `b${Date.now() % 1e6}`, email: `b${Date.now()}@agents.commonly.local`, password: 'x'.repeat(12),
    isBot: true, botMetadata: { agentName: 'wren-test', instanceId: 'default' },
  });
  await AgentInstallation.create({
    agentName: 'wren-test', instanceId: 'default', podId: new mongoose.Types.ObjectId(),
    version: '1.0.0', status: 'active', installedBy: owner._id,
  });
  for (const [tok, mid] of [[DAEMON_A, 'machine-a'], [DAEMON_B, 'machine-b']]) {
    await AgentCredential.create({ tokenHash: hash(tok), kind: 'daemon', ownerUserId: owner._id, machineId: mid });
  }
});

const adopt = (tok) => request(app)
  .post('/api/agent-binding/adopt')
  .set('Authorization', `Bearer ${tok}`)
  .send({ agentName: 'wren-test', instanceId: 'default' });

describe('adoption CAS', () => {
  it('adopts an unbound agent; machineId comes from the credential, not the body', async () => {
    const res = await adopt(DAEMON_A);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ adopted: true, machineId: 'machine-a' });
    const row = await User.findById(bot._id).lean();
    expect(row.botMetadata.machineId).toBe('machine-a');
  });

  it('concurrent adopts: exactly one winner, loser gets 409 with the holder', async () => {
    const [a, b] = await Promise.all([adopt(DAEMON_A), adopt(DAEMON_B)]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.boundTo).toMatch(/machine-(a|b)/);
  });

  it('adopt is idempotent for the holding machine', async () => {
    await adopt(DAEMON_A);
    const again = await adopt(DAEMON_A);
    expect(again.status).toBe(200);
    expect(again.body.alreadyBound).toBe(true);
  });

  it('refuses adoption of an agent the daemon owner does not own', async () => {
    const stranger = await User.create({ username: 'str', email: 's@x.com', password: 'x'.repeat(12) });
    const tok = `cm_daemon_${'s'.repeat(32)}`;
    await AgentCredential.create({ tokenHash: hash(tok), kind: 'daemon', ownerUserId: stranger._id, machineId: 'machine-s' });
    const res = await adopt(tok);
    expect(res.status).toBe(403);
  });

  it('a revoked daemon credential cannot adopt', async () => {
    await AgentCredential.updateOne({ machineId: 'machine-a' }, { $set: { status: 'revoked' } });
    const res = await adopt(DAEMON_A);
    expect(res.status).toBe(401);
  });

  it('release (owner JWT) unbinds; a second machine can then adopt', async () => {
    await adopt(DAEMON_A);
    const rel = await request(app).post('/api/agent-binding/release')
      .send({ agentName: 'wren-test', instanceId: 'default' });
    expect(rel.status).toBe(200);
    const res = await adopt(DAEMON_B);
    expect(res.status).toBe(200);
    expect(res.body.machineId).toBe('machine-b');
  });
});
