const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');

describe('AgentInstallation wake-on-message opt-in', () => {
  let mongoServer;
  let owner;
  let guide;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({
      binary: { version: '7.0.14', skipMD5: true },
      instance: { dbName: 'agent-installation-wake-policy-test' },
    });
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await Promise.all([Pod.deleteMany({}), User.deleteMany({}), AgentInstallation.deleteMany({})]);
    owner = await User.create({ username: 'owner', email: 'owner@example.com', password: 'placeholder' });
    guide = await User.create({
      username: 'guide',
      email: 'guide@agent.local',
      password: 'placeholder',
      isBot: true,
    });
  });

  const installGuide = (podId) => AgentInstallation.install('guide', podId, {
    version: '1.0.0',
    installedBy: owner._id,
    config: { wakeOnMessage: { enabled: true } },
  });

  test('preserves an explicit opt-in for a personal chat', async () => {
    const pod = await Pod.create({
      name: 'My Workspace',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, guide._id],
    });

    await installGuide(pod._id);

    const installation = await AgentInstallation.findOne({ agentName: 'guide', podId: pod._id });
    expect(installation.config.get('wakeOnMessage')).toEqual({ enabled: true });
  });

  test('preserves the same explicit opt-in for a shared, bot-heavy chat', async () => {
    const teammate = await User.create({ username: 'teammate', email: 'teammate@example.com', password: 'placeholder' });
    const pod = await Pod.create({
      name: 'Project',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, guide._id, teammate._id],
    });

    await installGuide(pod._id);

    const installation = await AgentInstallation.findOne({ agentName: 'guide', podId: pod._id });
    expect(installation.config.get('wakeOnMessage')).toEqual({ enabled: true });
  });

  test('does not read pod shape before preserving the installation setting', async () => {
    const pod = await Pod.create({
      name: 'My Workspace',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, guide._id],
    });
    const lookup = jest.spyOn(Pod, 'findById').mockImplementationOnce(() => {
      throw new Error('temporary database error');
    });

    await installGuide(pod._id);

    const installation = await AgentInstallation.findOne({ agentName: 'guide', podId: pod._id });
    expect(installation.config.get('wakeOnMessage')).toEqual({ enabled: true });
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });

  test('defaults the server-owned GitHub issue-write capability to off', async () => {
    const pod = await Pod.create({
      name: 'Capability default',
      type: 'chat',
      createdBy: owner._id,
      members: [owner._id, guide._id],
    });

    const installation = await AgentInstallation.create({
      agentName: 'guide',
      podId: pod._id,
      version: '1.0.0',
      installedBy: owner._id,
    });

    expect(installation.githubIssueWrite).toBe(false);
  });
});
