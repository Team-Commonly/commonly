// ADR-026 Phase 0 invariants, pinned against mongodb-memory-server:
// lineage-aware auth (a child of a revoked parent is dead even though the
// bearer string is intact), cascade revocation, and the legacy fallback
// (embedded-only tokens keep working — the additive-migration guarantee).
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

jest.mock('../../../middleware/auth', () => {
  const touchLastActive = jest.fn();
  const mw = (req, res, next) => { req.user = { id: 'user-1' }; next(); };
  mw.touchLastActive = touchLastActive;
  return mw;
});

const { hash } = require('../../../utils/secret');

let mongod;
let AgentCredential;
let User;
let agentRuntimeAuth;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentCredential = require('../../../models/AgentCredential');
  User = require('../../../models/User');
  agentRuntimeAuth = require('../../../middleware/agentRuntimeAuth').default;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const runAuth = async (rawToken) => {
  const req = { header: (h) => (h === 'Authorization' ? `Bearer ${rawToken}` : undefined) };
  const res = makeRes();
  let nexted = false;
  await agentRuntimeAuth(req, res, () => { nexted = true; });
  return { req, res, nexted };
};

const makeBot = async (rawToken) => User.create({
  username: `bot-${Math.random().toString(36).slice(2, 8)}`,
  email: `${Math.random().toString(36).slice(2, 8)}@agents.commonly.local`,
  password: 'x'.repeat(12),
  isBot: true,
  botMetadata: { agentName: 'testbot', instanceId: 'default' },
  agentRuntimeTokens: [{ tokenHash: hash(rawToken), label: 't', createdAt: new Date() }],
});

describe('AgentCredential substrate', () => {
  it('legacy embedded-only tokens still authenticate (additive guarantee)', async () => {
    const raw = `cm_agent_${'l'.repeat(32)}`;
    await makeBot(raw);
    const { nexted } = await runAuth(raw);
    expect(nexted).toBe(true);
  });

  it('a revoked credential is rejected even though the embedded hash remains', async () => {
    const raw = `cm_agent_${'r'.repeat(32)}`;
    const bot = await makeBot(raw);
    const cred = await AgentCredential.create({
      tokenHash: hash(raw), kind: 'runtime', ownerUserId: bot._id, agentUserId: bot._id,
    });
    expect((await runAuth(raw)).nexted).toBe(true);
    await AgentCredential.revokeCascade(cred._id);
    const { res, nexted } = await runAuth(raw);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('a child of a revoked daemon credential is rejected — lineage enforced at auth', async () => {
    const raw = `cm_agent_${'c'.repeat(32)}`;
    const bot = await makeBot(raw);
    const daemon = await AgentCredential.create({
      tokenHash: hash(`cm_daemon_${'d'.repeat(32)}`), kind: 'daemon', ownerUserId: bot._id, machineId: 'm1',
    });
    await AgentCredential.create({
      tokenHash: hash(raw), kind: 'runtime', ownerUserId: bot._id, agentUserId: bot._id, parentId: daemon._id,
    });
    expect((await runAuth(raw)).nexted).toBe(true);
    await AgentCredential.updateOne({ _id: daemon._id }, { $set: { status: 'revoked', revokedAt: new Date() } });
    const { res, nexted } = await runAuth(raw);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/Issuing credential revoked/);
  });

  it('revokeCascade revokes the parent and every descendant', async () => {
    const owner = new mongoose.Types.ObjectId();
    const daemon = await AgentCredential.create({
      tokenHash: hash(`cm_daemon_${'x'.repeat(32)}`), kind: 'daemon', ownerUserId: owner, machineId: 'm2',
    });
    const kids = await Promise.all([1, 2, 3].map((i) => AgentCredential.create({
      tokenHash: hash(`cm_agent_${String(i).repeat(32)}`), kind: 'runtime', ownerUserId: owner, parentId: daemon._id,
    })));
    const revoked = await AgentCredential.revokeCascade(daemon._id);
    expect(revoked).toBe(4);
    const after = await AgentCredential.find({ _id: { $in: [daemon._id, ...kids.map((k) => k._id)] } });
    expect(after.every((c) => c.status === 'revoked')).toBe(true);
  });
});
