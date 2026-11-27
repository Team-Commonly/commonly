// F655: whose agent is it, in this pod. One rule for every reader: the
// installation's installer when that is a person, else the identity's
// ownerUserId when that is a person. An agent never owns an agent.
const mongoose = require('mongoose');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  resolveAgentOwners, displayOwnerId, isOwner, displayOwnersForPod,
} = require('../../../services/agentOwnerService');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('agentOwnerService', () => {
  let lily;
  let sam;
  let podId;

  const person = (name) => User.create({
    username: `${name}-${new mongoose.Types.ObjectId()}`,
    email: `${name}-${new mongoose.Types.ObjectId()}@test.com`,
    password: 'Password123!',
  });
  const agent = (agentName, instanceId, extra = {}) => User.create({
    username: `${agentName}-${instanceId}-${new mongoose.Types.ObjectId()}`,
    email: `${agentName}-${new mongoose.Types.ObjectId()}@bots.test`,
    password: 'Password123!',
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName, instanceId, ...extra },
  });
  const install = (agentName, instanceId, installedBy, status = 'active') => AgentInstallation.create({
    agentName, instanceId, podId, installedBy, status, version: '1.0.0',
  });

  beforeAll(async () => { await setupMongoDb(); });
  afterAll(async () => { await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    lily = await person('lily');
    sam = await person('sam');
    podId = new mongoose.Types.ObjectId();
  });

  it('names the installer for an agent that has no ownerUserId', async () => {
    const nova = await agent('openclaw', 'nova');
    await install('openclaw', 'nova', lily._id);
    const owners = await resolveAgentOwners({ podId, agentUser: nova });
    expect(owners).toEqual({ installedBy: String(lily._id), ownerUserId: null });
    expect(displayOwnerId(owners)).toBe(String(lily._id));
  });

  it('keeps both sources, and the installer is the one shown', async () => {
    const nova = await agent('openclaw', 'nova', { ownerUserId: String(sam._id) });
    await install('openclaw', 'nova', lily._id);
    const owners = await resolveAgentOwners({ podId, agentUser: nova });
    expect(owners).toEqual({ installedBy: String(lily._id), ownerUserId: String(sam._id) });
    expect(displayOwnerId(owners)).toBe(String(lily._id));
    expect(isOwner(owners, sam._id)).toBe(true);
    expect(isOwner(owners, lily._id)).toBe(true);
  });

  it('drops an installer that is an agent, and falls back to ownerUserId', async () => {
    const nova = await agent('openclaw', 'nova', { ownerUserId: String(sam._id) });
    await install('openclaw', 'nova', nova._id);
    const owners = await resolveAgentOwners({ podId, agentUser: nova });
    expect(owners).toEqual({ installedBy: null, ownerUserId: String(sam._id) });
    expect(displayOwnerId(owners)).toBe(String(sam._id));
  });

  it('ignores an uninstalled installation and another pod\'s installation', async () => {
    const nova = await agent('openclaw', 'nova');
    await install('openclaw', 'nova', lily._id, 'uninstalled');
    await AgentInstallation.create({
      agentName: 'openclaw',
      instanceId: 'nova',
      podId: new mongoose.Types.ObjectId(),
      installedBy: sam._id,
      version: '1.0.0',
    });
    const owners = await resolveAgentOwners({ podId, agentUser: nova });
    expect(owners).toEqual({ installedBy: null, ownerUserId: null });
    expect(displayOwnerId(owners)).toBeNull();
    expect(isOwner(owners, lily._id)).toBe(false);
  });

  it('looks the agent up by id when it is not handed in', async () => {
    const nova = await agent('openclaw', 'nova');
    await install('openclaw', 'nova', lily._id, 'paused');
    expect(await resolveAgentOwners({ podId, agentUserId: nova._id }))
      .toEqual({ installedBy: String(lily._id), ownerUserId: null });
  });

  it('never throws: a bad id answers nobody', async () => {
    expect(await resolveAgentOwners({ podId: 'not-an-id', agentUserId: 'nope' }))
      .toEqual({ installedBy: null, ownerUserId: null });
  });

  it('resolves every agent member of a pod in one pass', async () => {
    const nova = await agent('openclaw', 'nova');
    const kai = await agent('claude-code', 'kai', { ownerUserId: String(sam._id) });
    const orphan = await agent('codex', 'orphan');
    await install('openclaw', 'nova', lily._id);
    const owners = await displayOwnersForPod(podId, [nova, kai, orphan, lily]);
    expect(owners.get(String(nova._id))).toBe(String(lily._id));
    expect(owners.get(String(kai._id))).toBe(String(sam._id));
    expect(owners.has(String(orphan._id))).toBe(false);
    expect(owners.has(String(lily._id))).toBe(false);
  });
});
