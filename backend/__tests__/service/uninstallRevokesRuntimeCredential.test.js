// Every way an agent's last installation goes away retires its runtime
// token (TASK-625), the way the uninstall routes do (#2221): deleting the pod
// and pruning a stale install now do it too, and a reinstall of the same
// identity starts from a fresh token.
//
// A real mongod, because the claim is about which stored records survive; the
// probe is the real runtime auth middleware, so "dead" means what an agent
// would see: its next call is a 401.
const express = require('express');
const rateLimit = require('express-rate-limit');
const request = require('supertest');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

jest.mock('../../services/starterTaskService', () => ({ completeConnectAgentStarterTask: jest.fn() }));

const Pod = require('../../models/Pod');
const User = require('../../models/User');
const AgentCredential = require('../../models/AgentCredential');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { issueRuntimeTokenForAgent } = require('../../routes/registry/tokens');
const { deletePodCascade } = require('../../services/podDeletionService');
const { pruneStaleInstallations } = require('../../services/agentInstallationCleanupService');
const agentRuntimeAuth = require('../../middleware/agentRuntimeAuth');

const app = express();
const probeLimit = rateLimit({ windowMs: 60 * 1000, max: 10000 });
app.get('/probe', probeLimit, agentRuntimeAuth, (req, res) => res.json({ agent: req.agentUser?.username || null }));
const probe = (token) => request(app).get('/probe').set('Authorization', `Bearer ${token}`);

const AGENT = 'maya-claude';
const ownerId = new mongoose.Types.ObjectId();

const makePod = (name) => Pod.create({ name, type: 'chat', createdBy: ownerId, members: [ownerId] });
const install = (pod, extra = {}) => AgentInstallation.create({
  agentName: AGENT,
  instanceId: 'default',
  podId: pod._id,
  installedBy: ownerId,
  status: 'active',
  displayName: 'Maya Claude',
  version: '1.0.0',
  ...extra,
});

const issue = async (installation) => {
  const agentUser = await AgentIdentityService.getOrCreateAgentUser(AGENT, { instanceId: 'default' });
  const issued = await issueRuntimeTokenForAgent(agentUser, 'CLI key', installation, { ownerUserId: ownerId });
  return issued.token;
};

const credentialStatus = async () => {
  const rows = await AgentCredential.find({ kind: 'runtime' }).select('status').lean();
  return rows.map((row) => row.status);
};

describe('the last installation going away revokes the runtime token', () => {
  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('deleting the only pod revokes it, and a reinstall does not revive it', async () => {
    const pod = await makePod('Only pod');
    const token = await issue(await install(pod));
    expect((await probe(token)).status).toBe(200);

    await deletePodCascade(String(pod._id));

    expect(await credentialStatus()).toEqual(['revoked']);
    expect(await User.countDocuments({ 'agentRuntimeTokens.0': { $exists: true } })).toBe(0);
    await install(await makePod('New pod'));
    expect((await probe(token)).status).toBe(401);
  });

  test('deleting one of two pods leaves the token working', async () => {
    const pod = await makePod('Doomed');
    const keep = await makePod('Kept');
    const token = await issue(await install(pod));
    await install(keep);

    await deletePodCascade(String(pod._id));

    expect(await credentialStatus()).toEqual(['active']);
    expect((await probe(token)).status).toBe(200);
  });

  test('pruning the last stale install revokes it, and a reinstall does not revive it', async () => {
    const pod = await makePod('Stale pod');
    const installation = await install(pod);
    const token = await issue(installation);
    await AgentInstallation.updateOne(
      { _id: installation._id },
      { $set: { status: 'stale', staleSince: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
    );

    const result = await pruneStaleInstallations(14);

    expect(result).toEqual({ deleted: 1, failures: 0 });
    expect(await credentialStatus()).toEqual(['revoked']);
    await install(pod);
    expect((await probe(token)).status).toBe(401);
  });
});
