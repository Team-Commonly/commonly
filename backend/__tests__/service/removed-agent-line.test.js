// F270: "was removed" is stored in the room for good, so it has to be true. An empty
// result for active rows isn't enough: a paused agent, or a row an exact match misses,
// reads the same and nobody removed either.
const mockEmitRemoved = jest.fn();
const mockEmitPaused = jest.fn();
const mockHasPaused = jest.fn();
jest.mock('../../services/systemActionLineService', () => ({
  emitRemovedLine: (...args) => mockEmitRemoved(...args),
  emitPausedLine: (...args) => mockEmitPaused(...args),
  hasPausedLineSince: (...args) => mockHasPaused(...args),
  emitStoppedLine: jest.fn(),
  hasRemovedLineSince: jest.fn().mockResolvedValue(false),
  hasStoppedLineSince: jest.fn().mockResolvedValue(false),
}));
const mongoose = require('mongoose');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { noteUnreachableAgentDm } = require('../../services/stoppedMentionService');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');

const podId = new mongoose.Types.ObjectId();
const args = {
  podId: String(podId), agentName: 'nova', instanceId: 'default', messageId: '555',
};
// Written around the model, as a row from before the identity rules would be.
const row = (overrides) => AgentInstallation.collection.insertOne({
  agentName: 'nova',
  instanceId: 'default',
  podId: new mongoose.Types.ObjectId(),
  status: 'uninstalled',
  version: '1.0.0',
  installedBy: new mongoose.Types.ObjectId(),
  ...overrides,
});

beforeAll(setupMongoDb);
beforeEach(async () => {
  jest.clearAllMocks();
  mockHasPaused.mockResolvedValue(false);
  await clearMongoDb();
  await User.collection.insertOne({
    username: 'nova', email: 'nova@example.test', isBot: true, botMetadata: { agentName: 'nova', instanceId: 'default' },
  });
});
afterAll(closeMongoDb);

const expectQuiet = async () => {
  expect(await noteUnreachableAgentDm(args)).toBe(false);
  expect(mockEmitRemoved).not.toHaveBeenCalled();
  expect(mockEmitPaused).not.toHaveBeenCalled();
};

it('says so when every row the agent had is uninstalled', async () => {
  await row();
  await row();
  expect(await noteUnreachableAgentDm(args)).toBe(true);
  expect(mockEmitRemoved).toHaveBeenCalledTimes(1);
});

it('says so when the agent has no row at all', async () => {
  expect(await noteUnreachableAgentDm(args)).toBe(true);
});

it('says paused, not removed, when a row is paused and the rest are gone', async () => {
  await row({ status: 'paused' });
  await row();
  expect(await noteUnreachableAgentDm(args)).toBe(true);
  expect(mockEmitPaused).toHaveBeenCalledTimes(1);
  expect(mockEmitPaused.mock.calls[0][0]).toMatchObject({ agentKey: 'nova:default', messageId: '555' });
  expect(mockEmitRemoved).not.toHaveBeenCalled();
});

it('says paused for a row under the name this agent used to have', async () => {
  await User.collection.updateOne({ username: 'nova' }, {
    $set: { username: 'commonly-bot', 'botMetadata.agentName': 'commonly-bot' },
  });
  await row({ agentName: 'commonly-summarizer', status: 'paused' });
  expect(await noteUnreachableAgentDm({ ...args, agentName: 'commonly-bot' })).toBe(true);
  expect(mockEmitPaused).toHaveBeenCalledTimes(1);
});

it('says paused once a day', async () => {
  await row({ status: 'paused' });
  mockHasPaused.mockResolvedValue(true);
  await expectQuiet();
});

it('stays quiet when a paused row sits beside a stale one, since neither line is sure', async () => {
  await row({ status: 'paused' });
  await row({ status: 'stale' });
  await expectQuiet();
});

it('stays quiet when a paused row sits beside an active one the caller missed', async () => {
  await row({ status: 'paused' });
  await row({ status: 'active', agentName: 'NOVA' });
  await expectQuiet();
});

it('stays quiet for a row the cleanup marked stale, since nobody removed it', async () => {
  await row({ status: 'stale' });
  await expectQuiet();
});

it('stays quiet for an active row with no instanceId, which reads as default', async () => {
  await row({ status: 'active', instanceId: null });
  await expectQuiet();
});

it('stays quiet for an active row whose stored name differs in case', async () => {
  await row({ status: 'active', agentName: 'Nova', instanceId: 'Default' });
  await expectQuiet();
});

it('stays quiet for a row under the name this agent used to have', async () => {
  await User.collection.insertOne({
    username: 'commonly-bot',
    email: 'bot@example.test',
    isBot: true,
    botMetadata: { agentName: 'commonly-bot', instanceId: 'default' },
  });
  await row({ status: 'active', agentName: 'commonly-summarizer' });
  expect(await noteUnreachableAgentDm({ ...args, agentName: 'commonly-bot' })).toBe(false);
  expect(mockEmitRemoved).not.toHaveBeenCalled();
});

it("doesn't let another agent's row speak for this one", async () => {
  await row({ status: 'active', agentName: 'milo' });
  expect(await noteUnreachableAgentDm(args)).toBe(true);
});
