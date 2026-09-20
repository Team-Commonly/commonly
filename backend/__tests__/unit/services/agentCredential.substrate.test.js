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

// TASK-094: the child path must not fire the connect-agent starter task, so the
// assertion needs a spy rather than the real service (which would also write
// through other collections this suite does not set up).
jest.mock('../../../services/starterTaskService', () => ({
  completeConnectAgentStarterTask: jest.fn(),
}));

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

  it('rejects a daemon credential even if its hash is poisoned into a legacy token list', async () => {
    // The cm_agent spelling deliberately simulates an issuer/copy bug. The
    // credential kind, not that prefix, is the authority boundary.
    const raw = `cm_agent_${'p'.repeat(32)}`;
    const bot = await makeBot(raw);
    await AgentCredential.create({
      tokenHash: hash(raw), kind: 'daemon', ownerUserId: bot._id, machineId: 'm-poison',
    });

    const { res, nexted } = await runAuth(raw);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid agent credential');
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

// TASK-094: the per-spawn child credential, end to end on a real database —
// mint it, authenticate with it, revoke it, and prove the boundary that the
// narrow predicate draws (a legacy-shaped row is NOT an authority).
describe('per-spawn child credentials (TASK-094)', () => {
  const {
    mintSpawnCredential,
    revokeSpawnCredential,
    revokeOrphanSpawnCredentials,
  } = require('../../../services/spawnCredentialService');

  const makeSeat = async () => {
    const raw = `cm_agent_${Math.random().toString(36).slice(2)}${'s'.repeat(24)}`;
    const bot = await makeBot(raw);
    const seat = await AgentCredential.create({
      tokenHash: hash(raw),
      kind: 'runtime',
      ownerUserId: bot._id,
      agentUserId: bot._id,
      machineId: 'machine-seat',
      label: 'Runtime token',
      scopes: [],
    });
    return { raw, bot, seat };
  };

  const mint = async (seat, spawnId, ttlSeconds) => {
    const result = await mintSpawnCredential({
      seat: {
        _id: seat._id,
        ownerUserId: seat.ownerUserId,
        agentUserId: seat.agentUserId,
        machineId: seat.machineId,
        scopes: seat.scopes,
      },
      spawnId,
      ttlSeconds,
    });
    expect(result.ok).toBe(true);
    return result;
  };

  it('a minted child authenticates as its seat even though it has no embedded record', async () => {
    const { bot, seat } = await makeSeat();
    const child = await mint(seat, 'spawn-a');

    const { req, nexted } = await runAuth(child.token);

    expect(nexted).toBe(true);
    expect(String(req.agentUser._id)).toBe(String(bot._id));
    expect(req.agentTokenHash).toBe(hash(child.token));
    expect(String(req.agentCredential._id)).toBe(String(child.credentialId));
  });

  it('the child is the seat for authorization: it resolves the seat\'s installations', async () => {
    const { bot, seat } = await makeSeat();
    const { AgentInstallation } = require('../../../models/AgentRegistry');
    const podId = new mongoose.Types.ObjectId();
    await AgentInstallation.create({
      agentName: 'testbot', instanceId: 'default', podId, version: '1.0.0', installedBy: bot._id,
    });
    const child = await mint(seat, 'spawn-authz');

    const { req, nexted } = await runAuth(child.token);

    expect(nexted).toBe(true);
    expect(req.agentAuthorizedPodIds).toContain(String(podId));
  });

  it('the negative control: a credential row with an agentUserId but no spawn scope is NOT an authentication path', async () => {
    const owner = new mongoose.Types.ObjectId();
    const bot = await makeBot(`cm_agent_${'z'.repeat(32)}`);
    const raw = `cm_agent_${'n'.repeat(32)}`;
    await AgentCredential.create({
      tokenHash: hash(raw), kind: 'runtime', ownerUserId: owner, agentUserId: bot._id, scopes: [],
    });

    const { res, nexted } = await runAuth(raw);

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Invalid agent token');
  });

  it('a child does not fire the connect-agent starter task; a seat token still does', async () => {
    const { completeConnectAgentStarterTask } = require('../../../services/starterTaskService');
    completeConnectAgentStarterTask.mockClear();
    const { raw, seat } = await makeSeat();
    const child = await mint(seat, 'spawn-starter');

    await runAuth(child.token);
    expect(completeConnectAgentStarterTask).not.toHaveBeenCalled();

    await runAuth(raw);
    expect(completeConnectAgentStarterTask).toHaveBeenCalledTimes(1);
  });

  it('a revoked child stops authenticating, and the seat token is unaffected', async () => {
    const { raw, seat } = await makeSeat();
    const child = await mint(seat, 'spawn-b');
    await revokeSpawnCredential({ credentialId: child.credentialId, seatCredentialId: seat._id });

    const childAttempt = await runAuth(child.token);
    expect(childAttempt.nexted).toBe(false);
    expect(childAttempt.res.statusCode).toBe(401);
    expect(childAttempt.res.body.message).toBe('Token revoked');

    expect((await runAuth(raw)).nexted).toBe(true);
  });

  it('a child past its expiry is rejected without anyone revoking it', async () => {
    const { seat } = await makeSeat();
    const child = await mint(seat, 'spawn-expired');
    await AgentCredential.updateOne(
      { _id: child.credentialId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const { res, nexted } = await runAuth(child.token);

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toBe('Session token expired');
  });

  it('a child of a revoked seat dies with the seat, which is the cascade the window was missing', async () => {
    const { seat } = await makeSeat();
    const child = await mint(seat, 'spawn-cascade');

    await AgentCredential.revokeCascade(seat._id);

    const { res, nexted } = await runAuth(child.token);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/revoked/);
  });

  it('the boot sweep kills only the calling seat\'s children', async () => {
    const a = await makeSeat();
    const b = await makeSeat();
    const aChild = await mint(a.seat, 'spawn-a1');
    const bChild = await mint(b.seat, 'spawn-b1');

    const revoked = await revokeOrphanSpawnCredentials({ seatCredentialId: a.seat._id });

    expect(revoked).toBe(1);
    expect((await runAuth(aChild.token)).nexted).toBe(false);
    expect((await runAuth(bChild.token)).nexted).toBe(true);
  });
});
