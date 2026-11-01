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
    const asker = await person('river');
    const pod = await chatPod(asker);
    await install(pod, asker, 'river-agent', { displayName: 'River agent' });

    const cue = await askerStartCommandCue(String(pod._id), String(asker._id));

    expect(cue).toContain('"River agent"');
    // The listener command's shape: a bare run line fails without the token.
    expect(cue).toContain('npm i -g @commonlyai/cli@latest\nexport COMMONLY_API_URL=');
    expect(cue).toContain('export COMMONLY_AGENT_TOKEN=');
    expect(cue).toContain('commonly agent run river-agent --adapter');
    expect(cue).toMatch(/Bring your own page/);
    // Scout wakes on every message here, so the cue must not make it reply.
    expect(cue).toMatch(/If you reply/);
    expect(cue).not.toMatch(/Answer what they asked/);
  });

  test('says nothing once the agent has listened on its install token', async () => {
    const asker = await person('river');
    const pod = await chatPod(asker);
    await install(pod, asker, 'river-agent');
    await AgentInstallation.updateOne({ agentName: 'river-agent' }, {
      $set: { runtimeTokens: [{ tokenHash: 'h2', createdAt: new Date(), lastListenedAt: new Date() }] },
    });

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test('says nothing once the agent has listened', async () => {
    const asker = await person('river');
    const pod = await chatPod(asker);
    const bot = await install(pod, asker, 'river-agent');
    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h1', createdAt: new Date(), lastListenedAt: new Date() }] },
    });

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test('says nothing about an agent that ran before and went quiet', async () => {
    // Gone dark is not never connected: the start command may not be the fix.
    const asker = await person('river');
    const pod = await chatPod(asker);
    const bot = await install(pod, asker, 'river-agent');
    await User.updateOne({ _id: bot._id }, {
      $set: { agentRuntimeTokens: [{ tokenHash: 'h1', createdAt: new Date(), lastListenedAt: new Date(Date.now() - 2 * 3600e3) }] },
    });

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test("says nothing about someone else's agent", async () => {
    const asker = await person('river');
    const owner = await person('dana');
    const pod = await chatPod(owner, [asker._id]);
    await install(pod, owner, 'dana-agent');

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
  });

  test('says nothing to an agent, even about an agent it set up', async () => {
    const owner = await person('river');
    const pod = await chatPod(owner);
    const bot = await install(pod, owner, 'river-agent');
    await install(pod, bot, 'river-helper');

    expect(await askerStartCommandCue(String(pod._id), String(bot._id))).toBe('');
  });

  test('says nothing about an agent that runs on Commonly', async () => {
    const asker = await person('river');
    const pod = await chatPod(asker);
    await install(pod, asker, 'river-hosted', { config: { runtime: { runtimeType: 'native' } } });
    // Scout itself is such an install, so most turns must not reach the bot read.
    const find = jest.spyOn(User, 'find');

    expect(await askerStartCommandCue(String(pod._id), String(asker._id))).toBe('');
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });

  test("in the asker's own room with Scout, names their agent from another pod", async () => {
    const asker = await person('river');
    const team = await chatPod(asker);
    await install(team, asker, 'river-agent');
    const room = await Pod.create({ name: 'Scout', type: 'agent-room', createdBy: asker._id, members: [asker._id] });

    const cue = await askerStartCommandCue(String(room._id), String(asker._id));

    expect(cue).toContain('commonly agent run river-agent');
  });

  test('in a shared pod, says nothing about the asker\'s agent in another pod', async () => {
    const asker = await person('river');
    const team = await chatPod(asker);
    await install(team, asker, 'river-agent');
    const other = await chatPod(asker);

    expect(await askerStartCommandCue(String(other._id), String(asker._id))).toBe('');
  });

  test('an id that is not an ObjectId gives nothing', async () => {
    expect(await askerStartCommandCue('pod-1', String(new mongoose.Types.ObjectId()))).toBe('');
    expect(await askerStartCommandCue(String(new mongoose.Types.ObjectId()), 'human-1')).toBe('');
  });
});
