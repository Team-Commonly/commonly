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
const { selectLiveGrantsForIdentities, hostedBrokerToolsForRun } = require('../../services/grantBrokerProjectionService');
const { GRANT_BROKER_ID } = require('../../services/installable/toolInstallables');
const { dispatchTool, toolsForConfig } = require('../../services/nativeRuntimeService');
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

  // F40, seen on the TASK-340 prod walk (11-01): a live grant in the pod puts every
  // turn in in-pod-only mode, and that mode used to drop this tool. So a grant
  // minted before its task was claimed could never be used: the agent the grant
  // names could not take the claim the grant waits on.
  describe('in a pod holding an outsider-writable grant', () => {
    const offered = (opts) => toolsForConfig({ tools: [...HOSTED_NATIVE_TOOLS] }, true, opts)
      .map((tool) => tool.function.name);
    const claimInPod = (args, extra = {}) => dispatchTool('commonly_claim_task', args, {
      podId: String(pod._id), agentName: AGENT_NAME, instanceId: INSTANCE, displayName: 'Claim seat',
      installationConfig: {}, runId: 'run-claim', inPodOnly: true, ...extra,
    });

    it('is offered, and nothing else beyond reading and posting', () => {
      expect(offered().sort()).toEqual(['commonly_claim_task', 'commonly_post_message', 'commonly_read_context']);
    });

    it('claims, and the grant bound to that task then reaches it', async () => {
      await mintGrant({
        connectionId: 'fixture', installationId: 'fixture', target: { kind: 'pod', id: String(pod._id) },
        tools: ['github.list_issues'], writeMode: 'read', audience: [String(bot._id)],
        expiresAt: new Date(Date.now() + 3600000), brokerId: GRANT_BROKER_ID,
        binding: { podId: String(pod._id), taskId: 'TASK-001' },
      });
      const result = await claimInPod({ taskId: 'TASK-001' });
      expect(result.error).toBeUndefined();
      expect(result.content).toMatchObject({ ok: true, taskId: 'TASK-001', status: 'claimed' });
      expect(await liveGrants()).toHaveLength(1);
    });

    it('is withdrawn once a granted tool has answered in the turn, and refused if called', async () => {
      expect(offered({ brokerCallSeen: true })).not.toContain('commonly_claim_task');
      const result = await claimInPod({ taskId: 'TASK-001' }, { brokerCallSeen: true });
      expect(result.error).toBe('outsider_writable_grant_tool_denied');
      expect(await Task.findOne({ taskId: 'TASK-001' }).lean()).toMatchObject({ status: 'pending' });
    });

    // CodeRabbit on #3258: in-pod-only is re-read every round, so a grant that
    // lapses after its tool answered lifts the narrowing mid-turn. The claim's
    // withdrawal follows the broker result, not the grant that produced it.
    it('stays withdrawn after a granted tool answered, even once the pod holds no grant', async () => {
      const names = toolsForConfig({ tools: [...HOSTED_NATIVE_TOOLS] }, false, { brokerCallSeen: true })
        .map((tool) => tool.function.name);
      expect(names).not.toContain('commonly_claim_task');
      expect(names).toContain('commonly_post_message');
      const result = await claimInPod({ taskId: 'TASK-001' }, { inPodOnly: false, brokerCallSeen: true });
      expect(result.error).toBe('outsider_writable_grant_tool_denied');
      expect(await Task.findOne({ taskId: 'TASK-001' }).lean()).toMatchObject({ status: 'pending' });
    });

    // Review of F40 (security): a seat-targeted grant is projected into the
    // agent's turns in every pod, and the bound task's claim is checked against
    // the task's own pod. Once a hosted agent can claim in a pod with a grant,
    // a turn elsewhere could use that task's tools. Bound grants stay home.
    it('offers a task-bound grant only in a run in its own pod', async () => {
      const elsewhere = await Pod.create({ name: 'Elsewhere', createdBy: bot._id, members: [bot._id] });
      await mintGrant({
        connectionId: 'fixture', installationId: 'fixture', target: { kind: 'seat', id: String(bot._id) },
        tools: ['github.list_issues'], writeMode: 'read', audience: [String(bot._id)],
        expiresAt: new Date(Date.now() + 3600000), brokerId: GRANT_BROKER_ID,
        binding: { podId: String(pod._id), taskId: 'TASK-001' },
      });
      expect((await claimInPod({ taskId: 'TASK-001' })).error).toBeUndefined();

      const home = await hostedBrokerToolsForRun({ identityId: String(bot._id), podId: String(pod._id) });
      const away = await hostedBrokerToolsForRun({ identityId: String(bot._id), podId: String(elsewhere._id) });
      expect(home.dispatch.size).toBe(1);
      expect(away.dispatch.size).toBe(0);

      // The call-time refusal is in toolBrokerService.hosted.test.js: the broker
      // records every refusal in Postgres, which this suite does not run.
    });

    it('stays out of a turn that has read the web', async () => {
      expect(offered({ webTainted: true })).not.toContain('commonly_claim_task');
      const result = await claimInPod({ taskId: 'TASK-001' }, { webTainted: true });
      expect(result.error).toBe('web_tainted_tool_denied');
      expect(await Task.findOne({ taskId: 'TASK-001' }).lean()).toMatchObject({ status: 'pending' });
    });
  });
});
