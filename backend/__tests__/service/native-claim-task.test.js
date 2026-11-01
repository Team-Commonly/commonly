/**
 * TASK-340: a task-bound grant had no agent on prod that could use it. Use
 * needs the bound task's authenticated claim, connector grants can only go to
 * hosted native agents, and hosted agents had no way to claim. Measured on the
 * TASK-288 walk: the bound grant's tool never surfaced.
 *
 * commonly_claim_task claims as the run's own bot User, through the route's
 * claim function. Real Mongo, so the grant projection reads the claim the tool
 * wrote. Provider I/O and unrelated grant confinement are mocked.
 */
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../services/agentComputerBroker', () => ({ agentComputerBroker: {}, agentComputerEnabled: false }));
jest.mock('../../services/githubAppService', () => ({ listOpenIssues: jest.fn(async () => []), isPatConfigured: jest.fn(() => false) }));
jest.mock('../../models/Integration', () => ({ findOne: jest.fn(async () => ({
  type: 'github-app', status: 'connected', createdBy: 'owner', createdAt: new Date('2020-01-01'),
  config: { installationId: 'fixture', owner: 'fixture', repo: 'fixture' },
})) }));
jest.mock('../../services/seatGrantConfinement', () => ({
  judgeSeatConfinement: jest.fn(async () => ({ refusal: null, scope: 'unbound' })),
}));
jest.mock('../../services/outsiderGrantPodEligibility', () => ({
  outsiderGrantPodRefusal: jest.fn(async () => null), outsiderGrantRefusalMessage: jest.fn(),
}));
const mockEmitTaskUpdated = jest.fn();
const mockNotifyPodAgents = jest.fn();
jest.mock('../../services/taskEventService', () => ({
  emitTaskUpdated: (...args) => mockEmitTaskUpdated(...args),
  notifyPodAgents: (...args) => mockNotifyPodAgents(...args),
}));
jest.mock('../../services/systemActionLineService', () => ({ emitSystemActionLine: jest.fn(async () => {}) }));

const mongoose = require('mongoose');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const AgentIdentityService = require('../../services/agentIdentityService');
const { mintGrant } = require('../../services/roomGrantService');
const { selectLiveGrantsForIdentities } = require('../../services/grantBrokerProjectionService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { dispatchTool } = require('../../services/nativeRuntimeService');
const { HOSTED_NATIVE_TOOLS } = require('../../services/hostedEngine');

jest.setTimeout(60000);

const AGENT_NAME = 'claude-code';
const INSTANCE = 'claim-seat';

describe('commonly_claim_task (TASK-340)', () => {
  let bot;
  let pod;

  beforeAll(async () => {
    await setupMongoDb();
    bot = await User.create({
      username: AgentIdentityService.buildAgentUsername(AgentIdentityService.resolveAgentType(AGENT_NAME), INSTANCE),
      email: 'claim-seat@test.com', password: 'password123', isBot: true,
      botMetadata: { agentName: AGENT_NAME, instanceId: INSTANCE },
    });
  });
  afterAll(async () => closeMongoDb());

  beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pod.deleteMany({}), Task.deleteMany({})]);
    pod = await Pod.create({ name: 'Claim fixture', createdBy: bot._id, members: [bot._id] });
    await Task.create({ podId: pod._id, taskNum: 1, taskId: 'TASK-001', title: 'Bound work', status: 'pending' });
  });

  const claim = (args, podId = pod._id) => dispatchTool('commonly_claim_task', args, {
    podId: String(podId), agentName: AGENT_NAME, instanceId: INSTANCE, displayName: 'Claim seat',
    installationConfig: {}, runId: 'run-claim',
  });
  const liveGrants = async () => (await selectLiveGrantsForIdentities({
    identityIds: [String(bot._id)], podIds: [String(pod._id)],
  })).get(String(bot._id)) || [];

  it('claims as the agent itself, and the grant bound to that task then reaches it', async () => {
    await mintGrant({
      connectionId: 'fixture', installationId: 'fixture', target: { kind: 'pod', id: String(pod._id) },
      tools: ['github.list_issues'], writeMode: 'read', audience: [String(bot._id)],
      expiresAt: new Date(Date.now() + 3600000), brokerId: GRANT_BROKER_ID,
      binding: { podId: String(pod._id), taskId: 'TASK-001' },
    });
    expect(await liveGrants()).toHaveLength(0);

    const result = await claim({ taskId: 'TASK-001' });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatchObject({ ok: true, taskId: 'TASK-001', status: 'claimed' });

    const task = await Task.findOne({ taskId: 'TASK-001' }).lean();
    // Both keys are the bot User id, as a seat's own claim over its runtime token
    // carries them (agentRuntimeAuth sets req.agentUser only, so claimedBy falls to the id).
    expect(task).toMatchObject({ status: 'claimed', claimedByUserId: String(bot._id), claimedBy: String(bot._id) });
    expect(task.claimExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await liveGrants()).toHaveLength(1);
    expect(mockEmitTaskUpdated).toHaveBeenCalledTimes(1);
    expect(mockNotifyPodAgents).toHaveBeenCalledWith(
      String(pod._id), expect.anything(), 'updated',
      expect.objectContaining({ isAgent: true, agentName: AGENT_NAME, instanceId: INSTANCE }), expect.anything(),
    );
  });

  it('does not take a task someone else holds a live claim on', async () => {
    const holder = new mongoose.Types.ObjectId().toString();
    const until = new Date(Date.now() + 600000);
    await Task.updateOne({ taskId: 'TASK-001' }, { $set: {
      status: 'claimed', claimedBy: 'someone', claimedByUserId: holder, claimedAt: new Date(), claimExpiresAt: until,
    } });
    const before = await Task.findOne({ taskId: 'TASK-001' }).lean();
    mockEmitTaskUpdated.mockClear();
    mockNotifyPodAgents.mockClear();
    const result = await claim({ taskId: 'TASK-001' });
    expect(result.content).toMatchObject({ ok: false, claimedBy: 'someone' });
    expect(result.error).toBe('task_already_claimed');
    // A refusal has no side effects: the row, its updates, and nobody woken.
    expect(await Task.findOne({ taskId: 'TASK-001' }).lean()).toEqual(before);
    expect(mockEmitTaskUpdated).not.toHaveBeenCalled();
    expect(mockNotifyPodAgents).not.toHaveBeenCalled();
  });

  it("does not take another seat's live name-only claim that shares its instance id", async () => {
    // A legacy claim keyed by display name only. Keyed by instance id, the hosted
    // claim would match the legacy renewal CAS, which has no expiry predicate.
    const until = new Date(Date.now() + 600000);
    await Task.updateOne({ taskId: 'TASK-001' }, { $set: {
      status: 'claimed', claimedBy: INSTANCE, claimedByUserId: null, claimedAt: new Date(), claimExpiresAt: until,
    } });
    const before = await Task.findOne({ taskId: 'TASK-001' }).lean();
    const result = await claim({ taskId: 'TASK-001' });
    expect(result.error).toBe('task_already_claimed');
    expect(await Task.findOne({ taskId: 'TASK-001' }).lean()).toEqual(before);
  });

  it('writes nothing for an agent that is not a member of the pod', async () => {
    const owner = new mongoose.Types.ObjectId();
    const elsewhere = await Pod.create({ name: 'Not mine', createdBy: owner, members: [owner] });
    await Task.create({ podId: elsewhere._id, taskNum: 1, taskId: 'TASK-001', title: 'Not mine', status: 'pending' });
    const result = await claim({ taskId: 'TASK-001' }, elsewhere._id);
    expect(result.content.ok).toBe(false);
    expect(result.error).toBe('not_a_member');
    expect((await Task.findOne({ podId: elsewhere._id }).lean()).status).toBe('pending');
  });

  it('names a missing task and requires a task id', async () => {
    expect((await claim({ taskId: 'TASK-404' })).content).toMatchObject({ ok: false, error: 'Task not found' });
    expect((await claim({})).error).toBe('missing_task_id');
  });

  it('is offered to hosted agents', () => {
    expect(HOSTED_NATIVE_TOOLS).toContain('commonly_claim_task');
  });
});
