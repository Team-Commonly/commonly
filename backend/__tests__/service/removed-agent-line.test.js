// F270: "was removed" is stored in the room for good, so it has to be true. An empty
// result for active rows isn't enough: a paused agent, or a row an exact match misses,
// reads the same and nobody removed either.
const mockEmitRemoved = jest.fn();
jest.mock('../../services/systemActionLineService', () => ({
  emitRemovedLine: (...args) => mockEmitRemoved(...args),
  emitStoppedLine: jest.fn(),
  hasRemovedLineSince: jest.fn().mockResolvedValue(false),
  hasStoppedLineSince: jest.fn().mockResolvedValue(false),
}));
const mongoose = require('mongoose');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { noteRemovedAgentDm } = require('../../services/stoppedMentionService');
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
  await clearMongoDb();
  await User.collection.insertOne({
    username: 'nova', email: 'nova@example.test', isBot: true, botMetadata: { agentName: 'nova', instanceId: 'default' },
  });
});
afterAll(closeMongoDb);

const expectQuiet = async () => {
  expect(await noteRemovedAgentDm(args)).toBe(false);
  expect(mockEmitRemoved).not.toHaveBeenCalled();
};

it('says so when every row the agent had is uninstalled', async () => {
  await row();
  await row();
  expect(await noteRemovedAgentDm(args)).toBe(true);
  expect(mockEmitRemoved).toHaveBeenCalledTimes(1);
});

it('says so when the agent has no row at all', async () => {
  expect(await noteRemovedAgentDm(args)).toBe(true);
});

it('stays quiet for a paused agent, which its owner can resume', async () => {
  await row({ status: 'paused' });
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

it("doesn't let another agent's row speak for this one", async () => {
  await row({ status: 'active', agentName: 'milo' });
  expect(await noteRemovedAgentDm(args)).toBe(true);
});
