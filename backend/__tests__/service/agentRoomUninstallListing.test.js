// TASK-759 — service tier. Uninstalling a BYO agent from its 1:1 room keeps
// the room pod (so a reinstall finds the same room), but the owner's default
// pod list must stop offering it: the room still shows starter prompts for an
// agent that is gone. This runs the real uninstall statics and the real
// getAllPods query against Mongo, so the room's presence in the list is
// measured, not inferred from the query shape.
process.env.PG_HOST = '';
const mongoose = require('mongoose');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const podController = require('../../controllers/podController');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const callGetAllPods = async (userId) => {
  const req = { query: {}, userId: String(userId), user: {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await podController.getAllPods(req, res);
  return res.json.mock.calls[0][0];
};

describe('agent-room leaves the owner list when its agent is uninstalled (TASK-759)', () => {
  let owner;
  let room;

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  afterEach(clearMongoDb);

  beforeEach(async () => {
    owner = new mongoose.Types.ObjectId();
    await User.create({ _id: owner, username: 'byo-owner', email: 'byo-owner@example.com', password: 'x' });
    room = await Pod.create({ name: 'Talk to byo', type: 'agent-room', createdBy: owner, members: [owner] });
    await AgentInstallation.create({
      agentName: 'byo-agent',
      podId: room._id,
      instanceId: 'default',
      version: '1.0.0',
      installedBy: owner,
      status: 'active',
    });
  });

  it('lists the room while its agent is installed', async () => {
    const body = await callGetAllPods(owner);
    expect(body.map((p) => String(p._id))).toContain(String(room._id));
  });

  it('keeps a room that has no installation row at all (failed install, legacy room)', async () => {
    const bare = await Pod.create({ name: 'Talk to nothing yet', type: 'agent-room', createdBy: owner, members: [owner] });
    const body = await callGetAllPods(owner);
    expect(body.map((p) => String(p._id))).toContain(String(bare._id));
  });

  it('keeps a room when one of two rows is still live, and hides it once both are uninstalled', async () => {
    await AgentInstallation.create({
      agentName: 'other-agent',
      podId: room._id,
      instanceId: 'default',
      version: '1.0.0',
      installedBy: owner,
      status: 'uninstalled',
    });
    // Only the byo-agent row is live here: it alone keeps the room listed.
    expect((await callGetAllPods(owner)).map((p) => String(p._id))).toContain(String(room._id));

    await AgentInstallation.uninstall('byo-agent', room._id, 'default');
    expect((await callGetAllPods(owner)).map((p) => String(p._id))).not.toContain(String(room._id));
  });

  it('drops the room after uninstall, and restores it on reinstall', async () => {
    await AgentInstallation.uninstall('byo-agent', room._id, 'default');

    const afterUninstall = await callGetAllPods(owner);
    expect(afterUninstall.map((p) => String(p._id))).not.toContain(String(room._id));
    // The pod and its history survive: uninstall detaches the runtime only.
    expect(await Pod.findById(room._id)).not.toBeNull();

    // A reinstall reactivates the same row (unique on agent, pod, instance).
    await AgentInstallation.updateOne(
      { agentName: 'byo-agent', podId: room._id, instanceId: 'default' },
      { status: 'active' },
    );

    const afterReinstall = await callGetAllPods(owner);
    expect(afterReinstall.map((p) => String(p._id))).toContain(String(room._id));
  });
});
