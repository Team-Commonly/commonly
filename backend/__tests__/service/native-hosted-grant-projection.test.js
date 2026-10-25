const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const mongoose = require('mongoose');

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../models/pg/Message', () => ({ findByPodId: jest.fn().mockResolvedValue([]) }));
jest.mock('../../services/agentTypingService', () => ({
  emitAgentTypingStart: jest.fn(), emitAgentTypingStop: jest.fn(),
}));
jest.mock('../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../../services/agentComputerBroker', () => ({ agentComputerBroker: {}, agentComputerEnabled: false }));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const RoomGrant = require('../../models/RoomGrant');
const AgentRun = require('../../models/AgentRun');
const { runAgent, resolveSeatUserId } = require('../../services/nativeRuntimeService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const axios = require('axios').default;

jest.setTimeout(60000);
let owner;
let seat;
let pod;
let previousEnv;
beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  previousEnv = { ...process.env };
  process.env.LITELLM_BASE_URL = 'http://litellm.test';
  process.env.LITELLM_MASTER_KEY = 'test-only';
  delete process.env.HOSTED_TURNS_PER_DAY;
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), RoomGrant.deleteMany({}), AgentRun.deleteMany({})]);
  owner = await User.create({ username: 'grant-owner', email: 'grant-owner@example.test', password: 'test-password' });
  seat = await User.create({ username: 'cto-walk-1016', email: 'cto-walk-1016@agents.commonly.local',
    password: 'test-password', isBot: true, botMetadata: { agentName: 'cto-walk-1016', instanceId: 'default' } });
  pod = await Pod.create({ name: 'Hosted grant service test', type: 'team', createdBy: owner._id,
    members: [owner._id, seat._id], publicRead: false, joinPolicy: 'invite-only' });
  axios.post.mockReset().mockResolvedValue({ data: {
    choices: [{ message: { role: 'assistant', content: 'Done.' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  } });
});
afterEach(() => { process.env = previousEnv; });

const grant = (over = {}) => RoomGrant.create({
  grantId: 'service-sentry-grant', connectionId: String(new mongoose.Types.ObjectId()),
  installationId: 'service-connection', target: { kind: 'pod', id: String(pod._id) },
  audience: [String(seat._id)], tools: ['sentry.find_organizations'], writeMode: 'read',
  expiresAt: new Date(Date.now() + 86400000), brokerId: GRANT_BROKER_ID, ...over,
});
const run = () => runAgent({ podId: pod._id, agentName: 'cto-walk-1016', instanceId: 'default',
  installedBy: owner._id, displayName: 'CTO walk',
  config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } },
}, { type: 'chat.mention', payload: { content: 'List available tools.' } });
const names = () => axios.post.mock.calls[0][1].tools.map((tool) => tool.function.name);

test('a real pod-targeted Sentry read grant reaches a native hosted turn', async () => {
  await grant();
  expect(await resolveSeatUserId(String(pod._id), 'cto-walk-1016', 'default')).toBe(String(seat._id));
  expect(await run()).toMatchObject({ status: 'succeeded' });
  expect(names()).toContain('sentry_find_organizations');
});

test('a current member outside the mint audience receives no Sentry capability', async () => {
  await grant({ audience: [String(owner._id)] });
  expect(await run()).toMatchObject({ status: 'succeeded' });
  expect(names()).not.toContain('sentry_find_organizations');
});
