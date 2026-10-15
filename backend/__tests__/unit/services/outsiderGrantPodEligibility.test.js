const mockPod = { findById: jest.fn() };
const mockIntegration = { find: jest.fn() };
const mockUser = { find: jest.fn() };
const mockInstallation = { find: jest.fn() };
jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/User', () => ({ __esModule: true, default: mockUser }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: mockInstallation }));

const { outsiderGrantPodRefusal, outsiderGrantRefusalMessage } = require('../../../services/outsiderGrantPodEligibility');
const POD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const HUMAN = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const AGENT = 'cccccccccccccccccccccccc';
let pod;
let bridges;
let users;
let installations;
const target = { kind: 'pod', id: POD };

beforeEach(() => {
  jest.clearAllMocks();
  pod = { members: [HUMAN, AGENT], publicRead: false, joinPolicy: 'invite-only' };
  bridges = [];
  users = [
    { _id: HUMAN, isBot: false, botType: null },
    { _id: AGENT, isBot: true, botType: 'agent', botMetadata: { agentName: 'guide', instanceId: 'default' } },
  ];
  installations = [{ agentName: 'guide', instanceId: 'default', config: { runtime: { runtimeType: 'native' } } }];
  mockPod.findById.mockReturnValue({ select: () => ({ lean: async () => pod }) });
  mockIntegration.find.mockReturnValue({ select: () => ({ lean: async () => bridges }) });
  mockUser.find.mockReturnValue({ select: () => ({ lean: async () => users }) });
  mockInstallation.find.mockReturnValue({ select: () => ({ lean: async () => installations }) });
});

test('a private closed unbridged pod with narrowed native agent and humans is eligible', async () => {
  expect(await outsiderGrantPodRefusal(target)).toBeNull();
});

test('a grant allowing unattended writes is ineligible even in a closed native pod', async () => {
  expect(await outsiderGrantPodRefusal(target, 'write')).toBe('write_mode_unconfined');
  expect(await outsiderGrantPodRefusal(target, 'write-with-confirm')).toBeNull();
});

test.each([
  [{ kind: 'seat', id: AGENT }, 'pod_required'],
  [{ kind: 'pod', id: '' }, 'pod_required'],
])('seat and missing targets are ineligible', async (input, reason) => {
  expect(await outsiderGrantPodRefusal(input)).toBe(reason);
});

test('a public pod is ineligible', async () => {
  pod.publicRead = true;
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_not_private');
});

test('a directly joinable or legacy pod is ineligible', async () => {
  pod.joinPolicy = 'open';
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_joinable');
  expect(outsiderGrantRefusalMessage('pod_joinable')).toMatch(/self-install/);
  expect(await outsiderGrantPodRefusal(target, 'read', { assumeInviteOnly: true })).toBeNull();
  delete pod.joinPolicy;
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_joinable');
});

test('closing a joinable pod does not hide its bridge or non-native agent refusal', async () => {
  pod.joinPolicy = 'open';
  bridges.push({ type: 'slack', scope: 'pod', podId: POD, status: 'connected', isActive: true });
  expect(await outsiderGrantPodRefusal(target, 'read', { assumeInviteOnly: true })).toBe('pod_bridged');
  bridges.pop();
  installations[0].config.runtime.runtimeType = 'webhook';
  expect(await outsiderGrantPodRefusal(target, 'read', { assumeInviteOnly: true })).toBe('non_native_agent');
});

test.each(['discord', 'telegram', 'slack'])('a live %s bridge is ineligible', async (type) => {
  bridges = [{ type, scope: 'pod', podId: POD, status: 'connected', isActive: true, config: { liveRelay: true } }];
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_bridged');
});

test('future pod integrations count as bridges unless explicitly known as credential rows', async () => {
  bridges = [{ type: 'future-channel', scope: 'pod', podId: POD, status: 'connected' }];
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_bridged');
  expect(mockIntegration.find.mock.calls[0][0].type).toEqual({ $nin: ['hosted-mcp', 'github-app'] });
});

test('a user-scoped bridge with an enabled gate is ineligible', async () => {
  bridges = [{ type: 'slack', scope: 'user', podId: HUMAN, status: 'connected',
    config: { liveRelay: true, gates: { [POD]: { enabled: true } } } }];
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_bridged');
});

test.each(['webhook', 'claude-code', 'moltbot'])('a %s agent is ineligible', async (runtimeType) => {
  installations[0].config.runtime.runtimeType = runtimeType;
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
});

// TASK-261: a hosted agent on the native engine runs through the same narrowed
// in-process runtime and holds no token; one on the Durable Object does not.
test('a hosted agent on the native engine counts as in-process', async () => {
  installations[0].config = { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } };
  expect(await outsiderGrantPodRefusal(target)).toBeNull();
});

test.each([
  ['on the Durable Object (no engine recorded)', {}],
  ['with an engine other than native', { hosted: { engine: 'durable-object' } }],
])('a hosted agent %s is ineligible', async (_label, extra) => {
  installations[0].config = { runtime: { runtimeType: 'hosted' }, ...extra };
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
});

test('an agent with no matching active installation is ineligible', async () => {
  installations = [];
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
});

test('an active installation without a member agent is ineligible', async () => {
  users.pop(); pod.members.pop();
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
});

test('a bridge identity or missing member record is ineligible', async () => {
  users[1].botType = 'bridge';
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
  users = users.slice(0, 1);
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
});

test('each pod change after an eligible attach is seen by the next check', async () => {
  expect(await outsiderGrantPodRefusal(target)).toBeNull();
  pod.joinPolicy = 'open';
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_joinable');
  pod.joinPolicy = 'invite-only';
  expect(await outsiderGrantPodRefusal(target)).toBeNull();
  pod.members.push('dddddddddddddddddddddddd');
  users.push({ _id: 'dddddddddddddddddddddddd', isBot: true, botType: 'agent',
    botMetadata: { agentName: 'outside', instanceId: 'default' } });
  expect(await outsiderGrantPodRefusal(target)).toBe('non_native_agent');
  pod.members.pop(); users.pop();
  expect(await outsiderGrantPodRefusal(target)).toBeNull();
  pod.publicRead = true;
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_not_private');
  pod.publicRead = false;
  bridges.push({ type: 'slack', scope: 'pod', podId: POD, status: 'connected', isActive: true });
  expect(await outsiderGrantPodRefusal(target)).toBe('pod_bridged');
});
