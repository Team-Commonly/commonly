// F46: a person set up a Bring your own agent, copied only the MCP snippet, and
// asked Scout something. Scout's reply never named the command that starts the
// agent. Scout's turn now carries that command inline whenever the person
// writing owns an agent here that has never connected. Built from state alone.
process.env.PG_HOST = '';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const Pod = require('../../models/Pod');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const { askerStartCommandCue } = require('../../services/askerStartCommandCue');

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(clearMongoDb);

const BYO = { runtime: { host: 'byo', runtimeType: 'claude-code' } };

const person = (username) => User.create({
  username, email: `${username}@example.com`, password: 'not-a-real-password', isBot: false,
});

const install = async (pod, owner, agentName, { config = BYO, displayName } = {}) => {
  const bot = await AgentIdentityService.getOrCreateAgentUser(agentName, { instanceId: 'default' });
  await AgentInstallation.create({
    agentName, instanceId: 'default', podId: pod._id, installedBy: owner._id, status: 'active', version: '1.0.0', config, displayName,
  });
  return bot;
};

const chatPod = (owner, members = []) => Pod.create({
  name: 'Team pod', type: 'chat', createdBy: owner._id, members: [owner._id, ...members],
});

describe('askerStartCommandCue', () => {
  test('names the start command for an agent the asker set up here that never connected', async () => {
    const asker = await person('kfir');
    const pod = await chatPod(asker);
    await install(pod, asker, 'kfir-agent', { displayName: 'Kfir agent' });

    const cue = await askerStartCommandCue(String(pod._id), String(asker._id));

    expect(cue).toContain('"Kfir agent"');
    expect(cue).toContain('npm i -g @commonlyai/cli@latest\ncommonly agent run kfir-agent');
    expect(cue).toMatch(/Bring your own page/);
  });

  test('says nothing once the agent has listened', async () => {
    const asker = await person('kfir');
    const pod = await chatPod(asker);
    const bot = await install(pod, asker, 'kfir-agent');
    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h1', createdAt: new Date(), lastListenedAt: new Date() }] },
    });

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test('says nothing about an agent that ran before and went quiet', async () => {
    // Gone dark is not never connected: the start command may not be the fix.
    const asker = await person('kfir');
    const pod = await chatPod(asker);
    const bot = await install(pod, asker, 'kfir-agent');
    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h1', createdAt: new Date(), lastListenedAt: new Date(Date.now() - 2 * 3600e3) }] },
    });

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test("says nothing about someone else's agent", async () => {
    const asker = await person('kfir');
    const owner = await person('dana');
    const pod = await chatPod(owner, [asker._id]);
    await install(pod, owner, 'dana-agent');

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test('says nothing to an agent, even about an agent it set up', async () => {
    const owner = await person('kfir');
    const pod = await chatPod(owner);
    const bot = await install(pod, owner, 'kfir-agent');
    await install(pod, bot, 'kfir-helper');

    expect(await askerStartCommandCue(String(pod._id), String(bot._id))).toBe('');
  });

  test('says nothing about an agent that runs on Commonly', async () => {
    const asker = await person('kfir');
    const pod = await chatPod(asker);
    await install(pod, asker, 'kfir-hosted', { config: { runtime: { runtimeType: 'native' } } });

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test("in the asker's own room with Scout, names their agent from another pod", async () => {
    const asker = await person('kfir');
    const team = await chatPod(asker);
    await install(team, asker, 'kfir-agent');
    const room = await Pod.create({ name: 'Scout', type: 'agent-room', createdBy: asker._id, members: [asker._id] });

    const cue = await askerStartCommandCue(String(room._id), String(asker._id));

    expect(cue).toContain('commonly agent run kfir-agent');
  });

  test('in a shared pod, says nothing about the asker\'s agent in another pod', async () => {
    const asker = await person('kfir');
    const team = await chatPod(asker);
    await install(team, asker, 'kfir-agent');
    const other = await chatPod(asker);

    expect(await askerStartCommandCue(String(other._id), String(asker._id))).toBe('');
  });

  test('an id that is not an ObjectId gives nothing', async () => {
    expect(await askerStartCommandCue('pod-1', String(new mongoose.Types.ObjectId()))).toBe('');
    expect(await askerStartCommandCue(String(new mongoose.Types.ObjectId()), 'human-1')).toBe('');
  });
});
