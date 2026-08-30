const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { hash } = require('../../../utils/secret');

let mongod;
let AgentCredential;
let daemonAuth;
let agentRuntimeAuth;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  AgentCredential = require('../../../models/AgentCredential');
  daemonAuth = require('../../../middleware/daemonAuth');
  agentRuntimeAuth = require('../../../middleware/agentRuntimeAuth').default;
});

afterEach(async () => {
  await AgentCredential.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

describe('daemonAuth', () => {
  it('authenticates only a scoped daemon credential and never assigns an agent identity', async () => {
    const token = `cm_daemon_${'a'.repeat(32)}`;
    const ownerUserId = new mongoose.Types.ObjectId();
    await AgentCredential.create({
      tokenHash: hash(token),
      kind: 'daemon',
      ownerUserId,
      machineId: 'machine-1',
      scopes: ['machine:heartbeat'],
    });
    const req = { header: (name) => (name === 'Authorization' ? `Bearer ${token}` : undefined) };
    const res = makeRes();
    let nexted = false;

    await daemonAuth('machine:heartbeat')(req, res, () => { nexted = true; });

    expect(nexted).toBe(true);
    expect(req.machine.machineId).toBe('machine-1');
    expect(req.user).toBeUndefined();
    expect(req.agentUser).toBeUndefined();
    expect(req.agentAuthorizedPodIds).toBeUndefined();

    const runtimeReq = { header: (name) => (name === 'Authorization' ? `Bearer ${token}` : undefined) };
    const runtimeRes = makeRes();
    await agentRuntimeAuth(runtimeReq, runtimeRes, () => {});
    expect(runtimeRes.statusCode).toBe(401);
  });

  it('rejects an agent bearer instead of treating it as a daemon credential', async () => {
    const req = { header: (name) => (name === 'Authorization' ? `Bearer cm_agent_${'a'.repeat(32)}` : undefined) };
    const res = makeRes();

    await daemonAuth('machine:heartbeat')(req, res, () => {});

    expect(res.statusCode).toBe(401);
    expect(req.machine).toBeUndefined();
  });

  it('requires the route scope before exposing a machine identity', async () => {
    const token = `cm_daemon_${'b'.repeat(32)}`;
    await AgentCredential.create({
      tokenHash: hash(token),
      kind: 'daemon',
      ownerUserId: new mongoose.Types.ObjectId(),
      machineId: 'machine-2',
      scopes: ['machine:heartbeat'],
    });
    const req = { header: (name) => (name === 'Authorization' ? `Bearer ${token}` : undefined) };
    const res = makeRes();

    await daemonAuth('machine:read')(req, res, () => {});

    expect(res.statusCode).toBe(403);
    expect(req.machine).toBeUndefined();
  });
});
