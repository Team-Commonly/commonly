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
const { excludedPodGrantNoticeForRun } = require('../../services/grantBrokerProjectionService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const axios = require('axios').default;
const AgentIdentityService = require('../../services/agentIdentityService');

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
const run = (instanceId = 'default') => runAgent({ podId: pod._id, agentName: 'cto-walk-1016', instanceId,
  installedBy: owner._id, displayName: 'CTO walk',
  config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } },
}, { type: 'chat.mention', payload: { content: 'List available tools.' } });
const names = () => axios.post.mock.calls[0][1].tools.map((tool) => tool.function.name);

test.each(['default', 'cto-walk'])('a pod-targeted Sentry read grant reaches native hosted instance %s', async (instanceId) => {
  seat.username = AgentIdentityService.buildAgentUsername('cto-walk-1016', instanceId);
  seat.botMetadata.instanceId = instanceId;
  await seat.save();
  await grant();
  expect(await resolveSeatUserId(String(pod._id), 'cto-walk-1016', instanceId)).toBe(String(seat._id));
  expect(await run(instanceId)).toMatchObject({ status: 'succeeded' });
  expect(names()).toContain('sentry_find_organizations');
});

test('a current member outside the mint audience receives no Sentry capability', async () => {
  await grant({ audience: [String(owner._id)] });
  expect(await run()).toMatchObject({ status: 'succeeded' });
  expect(names()).not.toContain('sentry_find_organizations');
  expect(axios.post.mock.calls[0][1].messages.some((message) => message.content.includes('audience does not include you'))).toBe(true);
});


test('an empty audience gives no tools but tells the native agent why', async () => {
  const row = await grant({ audience: [] });
  expect(await run()).toMatchObject({ status: 'succeeded' });
  expect(names()).not.toContain('sentry_find_organizations');
  const notice = axios.post.mock.calls[0][1].messages.find((message) => message.content.includes('audience does not include you'));
  expect(notice).toMatchObject({ role: 'system' });
  expect(notice.content).toContain('An empty audience grants access to nobody.');
  expect(notice.content).not.toContain(row.grantId);
  expect(notice.content).not.toContain(row.connectionId);
  expect((await RoomGrant.findById(row._id)).audience).toEqual([]);
});

test.each(['revoked', 'expired', 'other pod', 'seat target', 'not a member'])(
  'the notice reveals no grant for %s', async (state) => {
    const over = { audience: [] };
    if (state === 'revoked') over.revokedAt = new Date();
    if (state === 'expired') over.expiresAt = new Date(Date.now() - 1000);
    if (state === 'other pod') over.target = { kind: 'pod', id: String(new mongoose.Types.ObjectId()) };
    if (state === 'seat target') over.target = { kind: 'seat', id: String(owner._id) };
    await grant(over);
    if (state === 'not a member') await Pod.updateOne({ _id: pod._id }, { $pull: { members: seat._id } });
    expect(await excludedPodGrantNoticeForRun({ identityId: String(seat._id), podId: String(pod._id) })).toBeNull();
  },
);

test('an included agent gets tools without an exclusion notice', async () => {
  await grant();
  expect(await excludedPodGrantNoticeForRun({ identityId: String(seat._id), podId: String(pod._id) })).toBeNull();
});
