const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
// Model the server catalogue boundary; membership, installations and grant selection use Mongo.
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [
  { name: 'github.read', requiredWriteMode: 'read' },
  { name: 'github.write', requiredWriteMode: 'write-with-confirm' },
] }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const RoomGrant = require('../../models/RoomGrant');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { loadPlaybookContext } = require('../../services/playbooks/context');
let pod; let agent; let human;
beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  human = await User.create({ username: 'human', email: 'human@example.test', password: 'test-password' });
  agent = await User.create({ username: 'worker', email: 'worker@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'native-agent', instanceId: 'worker' } });
  pod = await Pod.create({ name: 'Playbook test', createdBy: human._id, members: [human._id, agent._id],
    publicRead: false, joinPolicy: 'invite-only' });
  await AgentInstallation.create({ agentName: 'native-agent', instanceId: 'worker', podId: pod._id,
    version: '1', installedBy: human._id, config: { runtime: { runtimeType: 'native' } } });
});
const grant = (extra = {}) => RoomGrant.create({ grantId: 'read-grant', connectionId: 'connection',
  installationId: 'installation', target: { kind: 'pod', id: String(pod._id) },
  tools: ['github.read', 'removed.tool', 'github.write'], writeMode: 'read',
  audience: [String(agent._id)], expiresAt: new Date(Date.now() + 60000), brokerId: 'commonly-grant-broker', ...extra });

test('loads verified members, active native runtime and only currently pinned allowed grant tools', async () => {
  await grant();
  const context = await loadPlaybookContext(String(pod._id));
  expect(context.grantPodRefusal).toBeNull();
  expect(context.members.find((m) => m.userId === String(agent._id))).toMatchObject({
    handle: 'worker', kind: 'agent', agentName: 'native-agent', instanceId: 'worker', runtime: 'native' });
  expect(context.tools).toEqual([{ name: 'github.read', mode: 'read', audience: [String(agent._id)] }]);
});
test('revocation, expiry and current membership take effect on the next load', async () => {
  const row = await grant();
  await RoomGrant.updateOne({ _id: row._id }, { $set: { revokedAt: new Date() } });
  expect((await loadPlaybookContext(String(pod._id))).tools).toEqual([]);
  await RoomGrant.updateOne({ _id: row._id }, { $set: { revokedAt: null, expiresAt: new Date(0) } });
  expect((await loadPlaybookContext(String(pod._id))).tools).toEqual([]);
  await RoomGrant.updateOne({ _id: row._id }, { $set: { expiresAt: new Date(Date.now() + 60000) } });
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: agent._id } });
  const context = await loadPlaybookContext(String(pod._id));
  expect(context.tools).toEqual([]);
  expect(context.members.map((m) => m.userId)).not.toContain(String(agent._id));
});
test('a seat grant cannot become a capability of this pod', async () => {
  await grant({ target: { kind: 'seat', id: String(agent._id) } });
  expect((await loadPlaybookContext(String(pod._id))).tools).toEqual([]);
});
test('paused installations cannot satisfy an agent role and make reads ineligible', async () => {
  await AgentInstallation.updateMany({}, { $set: { status: 'paused' } });
  const context = await loadPlaybookContext(String(pod._id));
  expect(context.members.find((m) => m.userId === String(agent._id)).runtime).toBeUndefined();
  expect(context.grantPodRefusal).toBe('non_native_agent');
});
