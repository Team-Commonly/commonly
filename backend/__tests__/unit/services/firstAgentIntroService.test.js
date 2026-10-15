const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');

const mockPostMessage = jest.fn(async () => ({ _id: 'intro' }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: (...args) => mockPostMessage(...args) }));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { maybePostFirstAgentIntro, resetFirstAgentIntroCacheForTest } = require('../../../services/firstAgentIntroService');

let serial = 0;
const person = async () => {
  serial += 1;
  return User.create({ username: `intro-person-${serial}`, email: `intro-${serial}@test.com`, password: 'password123' });
};
const install = async (owner, agentName, options = {}) => {
  const pod = await Pod.create({
    name: `Workspace ${serial}`,
    type: options.type || 'chat',
    createdBy: options.createdBy || owner._id,
    members: options.members || [owner._id],
  });
  const row = await AgentInstallation.create({
    agentName,
    instanceId: options.instanceId || 'default',
    displayName: options.displayName || agentName,
    podId: pod._id,
    installedBy: owner._id,
    version: '1.0.0',
    status: options.status || 'active',
  });
  return { pod, row };
};
const poll = (agentName, rows, instanceId = 'default') =>
  maybePostFirstAgentIntro(agentName, instanceId, rows);

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await AgentInstallation.deleteMany({});
  await Pod.deleteMany({});
  await User.deleteMany({});
  mockPostMessage.mockClear();
  resetFirstAgentIntroCacheForTest();
});

describe('first agent intro on runtime check-in', () => {
  test('first connected agent speaks once in a solo workspace, with a durable human mark', async () => {
    const owner = await person();
    await install(owner, 'scout', { status: 'active' });
    const { pod, row } = await install(owner, 'pixel', { displayName: 'Pixel' });

    await poll('pixel', [row]);
    await poll('pixel', [row]);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage.mock.calls[0][0]).toEqual(expect.objectContaining({
      agentName: 'pixel', podId: String(pod._id), displayName: 'Pixel',
      metadata: { kind: 'install-intro' },
    }));
    expect(mockPostMessage.mock.calls[0][0].content).toContain('Mention me with @pixel');
    const marked = await User.findById(owner._id).lean();
    expect(marked.onboarding.firstAgentIntroAt).toBeInstanceOf(Date);
  });

  test('two concurrent check-ins elect one poster', async () => {
    const owner = await person();
    const { row } = await install(owner, 'pixel');

    await Promise.all([poll('pixel', [row]), poll('pixel', [row])]);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect((await User.findById(owner._id).lean()).onboarding.firstAgentIntroAt).toBeInstanceOf(Date);
  });

  test("another person's first agent gets their own intro", async () => {
    const a = await person();
    const b = await person();
    const aInstall = await install(a, 'pixel');
    const bInstall = await install(b, 'pixel');

    await poll('pixel', [aInstall.row, bInstall.row]);

    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage.mock.calls.map(([arg]) => arg.podId).sort()).toEqual(
      [String(aInstall.pod._id), String(bInstall.pod._id)].sort(),
    );
  });

  test('a second agent is ineligible even when the first was uninstalled', async () => {
    const owner = await person();
    await install(owner, 'alice', { status: 'uninstalled' });
    const { row } = await install(owner, 'bob');

    await poll('bob', [row]);

    expect(mockPostMessage).not.toHaveBeenCalled();
    expect((await User.findById(owner._id).lean()).onboarding?.firstAgentIntroAt).toBeUndefined();
  });

  test('a two-person pod keeps its existing install-time intro rule', async () => {
    const owner = await person();
    const teammate = await person();
    const { row } = await install(owner, 'pixel', { members: [owner._id, teammate._id] });

    await poll('pixel', [row]);

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  test('the agent 1:1 room is eligible despite having two members', async () => {
    const owner = await person();
    const bot = await User.create({
      username: `intro-bot-${serial}`,
      email: `intro-bot-${serial}@test.com`,
      password: 'password123',
      isBot: true,
    });
    const { pod, row } = await install(owner, 'pixel', {
      type: 'agent-room', members: [bot._id, owner._id], createdBy: bot._id,
    });

    await poll('pixel', [row]);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage.mock.calls[0][0].podId).toBe(String(pod._id));
  });

  test('an ambiguous post failure does not permit a duplicate intro', async () => {
    const owner = await person();
    const { row } = await install(owner, 'pixel');
    mockPostMessage.mockRejectedValueOnce(new Error('store down'));

    await expect(poll('pixel', [row])).rejects.toThrow('store down');
    await poll('pixel', [row]);

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect((await User.findById(owner._id).lean()).onboarding.firstAgentIntroAt).toBeInstanceOf(Date);
  });
});
