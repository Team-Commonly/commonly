// F45: the task-completed memory goes to the agent the row's assignee names,
// matched the way the board stores it (the board name), never to an arbitrary
// agent that happens to share an agentName.
process.env.PG_HOST = '';
const mockAppend = jest.fn();
jest.mock('../../services/agentMemoryService', () => ({
  ...jest.requireActual('../../services/agentMemoryService'),
  appendSystemExchange: (...args) => mockAppend(...args),
}));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const { recordTaskCompleted } = require('../../services/systemExchangeTriggers');

let pod;
const bot = (username, agentName, instanceId) => User.create({
  username, email: `${username}@example.test`, password: 'Password123!', isBot: true, botType: 'agent', botMetadata: { agentName, instanceId },
});

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  mockAppend.mockReset().mockResolvedValue({ ok: true });
  const owner = await User.create({ username: 'memory-owner', email: 'memory-owner@example.test', password: 'Password123!' });
  const agents = await Promise.all([
    bot('openclaw-pixel', 'openclaw', 'pixel'),
    bot('openclaw-nova', 'openclaw', 'nova'),
    bot('rivet', 'rivet', 'default'),
  ]);
  pod = await Pod.create({ name: 'Memory pod', type: 'team', createdBy: owner._id, members: [owner._id, ...agents.map((a) => a._id)] });
  // The old lookup took the first active install with the agentName.
  await AgentInstallation.create({ agentName: 'openclaw', instanceId: 'nova', podId: pod._id, version: '1', installedBy: owner._id, status: 'active' });
});

const complete = (assignee) => recordTaskCompleted({ podId: String(pod._id), assignee, taskTitle: 'Ship it', prUrlOrStatus: 'done' });

test('a row assigned by board name records to that agent, even when its agentName is shared', async () => {
  await complete('pixel');
  expect(mockAppend).toHaveBeenCalledTimes(1);
  expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'openclaw', instanceId: 'pixel', kind: 'task-completed' }));
});

test('a default-instance agent records as before', async () => {
  await complete('rivet');
  expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'rivet', instanceId: 'default' }));
});

test('an agentName two agents share records to neither', async () => {
  await complete('openclaw');
  expect(mockAppend).not.toHaveBeenCalled();
});

test('a person or an unknown name records nothing', async () => {
  await complete('memory-owner');
  await complete('nobody');
  expect(mockAppend).not.toHaveBeenCalled();
});
