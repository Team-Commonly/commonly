/** Real grant/task authority across catalogue, call and approved-call paths.
 * Only provider I/O, the PG trail and unrelated confinement are mocked. */
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../../utils/testUtils');
const mongoose = require('mongoose');
const mockProvider = { listOpenIssues: jest.fn(), createIssue: jest.fn() };
const mockTrail = { create: jest.fn(async () => {}) };
jest.mock('../../../services/githubAppService', () => mockProvider);
jest.mock('../../../models/ToolCall', () => ({
  ...jest.requireActual('../../../models/ToolCall'),
  create: (...args) => mockTrail.create(...args),
}));
jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(async () => ({
  type: 'github-app', status: 'connected', createdBy: 'owner', createdAt: new Date('2020-01-01'),
  config: { installationId: 'fixture', owner: 'fixture', repo: 'fixture' },
})) }));
jest.mock('../../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: jest.fn(async () => ({ refusal: null, scope: 'unbound' })),
}));
jest.mock('../../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null), outsiderGrantRefusalMessage: jest.fn(),
}));
const Task = require('../../../models/Task');
const Pod = require('../../../models/Pod');
const { mintGrant } = require('../../../services/roomGrantService');
const { callTool, listToolsForGrant, executeApprovedToolCall } = require('../../../services/toolBrokerService');
const { selectLiveGrantsForIdentities } = require('../../../services/grantBrokerProjectionService');
const { GRANT_BROKER_ID } = require('../../../services/installable/toolInstallables');
const { digestArgs } = require('../../../models/ToolCall');
const POD = new mongoose.Types.ObjectId().toString();
const AGENT = new mongoose.Types.ObjectId().toString();
let grant;
beforeAll(setupMongoDb);
afterEach(clearMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  jest.clearAllMocks();
  mockProvider.listOpenIssues.mockResolvedValue([]);
  await Pod.create({ _id: POD, name: 'Broker fixture', createdBy: AGENT, members: [AGENT] });
  await Task.create({ podId: POD, taskNum: 1, taskId: 'TASK-1', title: 'Bound work', status: 'claimed',
    claimedBy: AGENT, claimedByUserId: AGENT, claimExpiresAt: new Date(Date.now() + 60000) });
  grant = await mintGrant({ connectionId: 'fixture', installationId: 'fixture', target: { kind: 'pod', id: POD },
    tools: ['github.list_issues', 'github.create_issue'], writeMode: 'write-with-confirm', audience: [AGENT],
    expiresAt: new Date(Date.now() + 3600000), brokerId: GRANT_BROKER_ID, binding: { podId: POD, taskId: 'TASK-1' } });
});
const caller = () => ({ grantId: grant.grantId, agentUserId: AGENT });

test('a live authenticated claimant receives tools and can execute an allowed read', async () => {
  expect((await selectLiveGrantsForIdentities({ identityIds: [AGENT], podIds: [POD] })).get(AGENT)).toHaveLength(1);
  const result = await callTool({ ...caller(), tool: 'github.list_issues', args: {} });
  expect(result.outcome).toBe('ok');
  expect(mockProvider.listOpenIssues).toHaveBeenCalledTimes(1);
});

test('a task claimed by somebody else disappears from projection and list, and cannot reach the provider', async () => {
  await Task.updateOne({ taskId: 'TASK-1' }, { $set: { claimedByUserId: new mongoose.Types.ObjectId().toString() } });
  expect((await selectLiveGrantsForIdentities({ identityIds: [AGENT], podIds: [POD] })).size).toBe(0);
  await expect(listToolsForGrant(caller())).rejects.toMatchObject({ code: 'task_claim_required' });
  await expect(callTool({ ...caller(), tool: 'github.list_issues', args: {} }))
    .rejects.toMatchObject({ code: 'task_claim_required' });
  expect(mockProvider.listOpenIssues).not.toHaveBeenCalled();
  expect(mockTrail.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', reason: 'task_claim_required' }));
});

test('an approval captured before close cannot execute after close, even if revocation cleanup missed the grant', async () => {
  const args = { title: 'Approved fixture' };
  const approved = { ...caller(), tool: 'github.create_issue', args, expectedArgsDigest: digestArgs(args), approvalId: 'fixture' };
  await Task.updateOne({ taskId: 'TASK-1' }, { $set: { status: 'done' }, $inc: { grantEpoch: 1 } });
  await expect(executeApprovedToolCall(approved)).rejects.toMatchObject({ code: 'task_closed' });
  expect(mockProvider.createIssue).not.toHaveBeenCalled();
  expect(mockTrail.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', reason: 'task_closed', approvalId: 'fixture' }));
});
