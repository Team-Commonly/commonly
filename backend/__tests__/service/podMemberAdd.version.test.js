// F621: the remaining atomic member adds bump the pod's version, as F619's do.
// A pod doc loaded before one of these adds, which then rewrites `members`
// whole through save() (removeAgentFromPod, leavePod), must get a VersionError
// instead of silently dropping the member the add wrote (and PG mirrored).
// One case per writer:
//   - podMemberAddService.addPodMemberByUsername (POST /api/pods/:id/members)
//   - communityPodService.ensureUserInCommunityPod (signup / OAuth)
//   - agentMentionService.autoJoinAgentToPod (mention auto-join)
//   - approvalActionService create_pod (the proposing agent joins the new pod)
//   - personaHireService.hirePersona
//   - authController.finishWorkspaceOnboarding (the signup Scout joins)
//   - admin globalIntegrations ensureGlobalSocialFeedPod (a second admin joins)
jest.mock('../../services/pgMirrorWrite', () => ({
  mirrorMemberAdded: jest.fn().mockResolvedValue(true),
  mirrorUser: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(async () => ({ _id: 'stub-event' })),
}));
jest.mock('../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue({ success: true }),
}));

const User = require('../../models/User');
const Pod = require('../../models/Pod');
const ApprovalAction = require('../../models/ApprovalAction');
const { AgentRegistry } = require('../../models/AgentRegistry');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const AgentIdentityService = require('../../services/agentIdentityService');
const { addPodMemberByUsername } = require('../../services/podMemberAddService');
const { ensureUserInCommunityPod } = require('../../services/communityPodService');
const { autoJoinAgentToPod } = require('../../services/agentMentionService');
const { resolveApproval } = require('../../services/approvalActionService');
const { hirePersona } = require('../../services/personaHireService');
const { finishWorkspaceOnboarding } = require('../../controllers/authController');
const { ensureGlobalSocialFeedPod } = require('../../routes/admin/globalIntegrations');

jest.setTimeout(60000);

let n = 0;
const makeUser = (fields = {}) => {
  n += 1;
  return User.create({
    username: `f621-user-${n}`, email: `f621-${n}@example.test`, password: 'Password123!', ...fields,
  });
};
const membersOf = async (podId) => (await Pod.findById(podId).lean()).members.map(String);
// A doc loaded before the add, rewriting `members` whole as removeAgentFromPod does.
const staleRemoveSave = async (stale, removeId) => {
  // eslint-disable-next-line no-param-reassign
  stale.members = stale.members.filter((m) => String(m) !== String(removeId));
  return stale.save();
};
const expectStaleSaveRefused = async (stale, removeId, podId, addedId) => {
  await expect(staleRemoveSave(stale, removeId)).rejects.toHaveProperty('name', 'VersionError');
  const members = await membersOf(podId);
  expect(members).toContain(String(addedId));
  expect(members).toContain(String(removeId));
};

let owner;
let other;
let pod;

beforeAll(async () => {
  await setupMongoDb();
});

afterAll(closeMongoDb);

beforeEach(async () => {
  owner = await makeUser();
  other = await makeUser();
  pod = await Pod.create({
    name: `f621-pod-${n}`, type: 'chat', createdBy: owner._id, members: [owner._id, other._id],
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.COMMUNITY_POD_ID;
});

describe('the remaining member adds bump the pod version (F621)', () => {
  it('addPodMemberByUsername', async () => {
    const teammate = await makeUser();
    await Pod.create({
      name: `f621-shared-${n}`, type: 'chat', createdBy: owner._id, members: [owner._id, teammate._id],
    });
    const stale = await Pod.findById(pod._id);

    const result = await addPodMemberByUsername({
      podId: String(pod._id), callerId: String(owner._id), username: teammate.username,
    });
    expect(result).toMatchObject({ alreadyMember: false });

    await expectStaleSaveRefused(stale, other._id, pod._id, teammate._id);
  });

  it('ensureUserInCommunityPod', async () => {
    process.env.COMMUNITY_POD_ID = String(pod._id);
    const joiner = await makeUser();
    const stale = await Pod.findById(pod._id);

    await ensureUserInCommunityPod(joiner._id);

    await expectStaleSaveRefused(stale, other._id, pod._id, joiner._id);
  });

  it('autoJoinAgentToPod (mention auto-join)', async () => {
    const stale = await Pod.findById(pod._id);

    expect(await autoJoinAgentToPod('f621-helper', 'default', String(pod._id), String(owner._id), true)).toBe(true);
    const helper = await User.findOne({ isBot: true, 'botMetadata.agentName': 'f621-helper' });

    await expectStaleSaveRefused(stale, other._id, pod._id, helper._id);
  });

  it('create_pod approval: the proposing agent joins the new pod', async () => {
    const name = `f621-created-${n}`;
    // The new pod exists only inside the call, so load the stale doc just
    // before the agent's member write: identity resolution is the last step
    // before it.
    let stale = null;
    const original = AgentIdentityService.getOrCreateAgentUser.bind(AgentIdentityService);
    jest.spyOn(AgentIdentityService, 'getOrCreateAgentUser').mockImplementation(async (...args) => {
      stale = await Pod.findOne({ name });
      return original(...args);
    });
    const action = await ApprovalAction.create({
      podId: pod._id, ownerUserId: owner._id, agentName: 'f621-proposer', instanceId: 'default',
      actionType: 'create_pod', params: { name }, summary: 'F621 create pod',
      expiresAt: new Date(Date.now() + 60000),
    });

    const res = await resolveApproval({ approvalId: action._id, callerUserId: owner._id, decision: 'approved' });
    expect(res.status).toBe(200);
    expect(stale).toBeTruthy();
    const created = await Pod.findOne({ name }).lean();
    const agent = await User.findOne({ isBot: true, 'botMetadata.agentName': 'f621-proposer' });

    await expectStaleSaveRefused(stale, owner._id, created._id, agent._id);
  });

  it('hirePersona', async () => {
    await AgentRegistry.deleteMany({ agentName: 'pod-welcomer' });
    await AgentRegistry.create({
      agentName: 'pod-welcomer', displayName: 'Pod Welcomer', description: 'F621 persona',
      registry: 'commonly-official', verified: true,
      manifest: {
        name: 'pod-welcomer', version: '1.0.0', capabilities: [{ name: 'memory', description: 'memory' }],
        context: { required: ['context:read'] }, runtime: { type: 'standalone', connection: 'rest' },
      },
      latestVersion: '1.0.0', versions: [{ version: '1.0.0', publishedAt: new Date() }],
    });
    const stale = await Pod.findById(pod._id);

    const hire = await hirePersona({ agentName: 'pod-welcomer', userId: String(owner._id), podId: String(pod._id) });
    expect(hire.botUserId).toBeTruthy();

    await expectStaleSaveRefused(stale, other._id, pod._id, hire.botUserId);
  });

  it('finishWorkspaceOnboarding (the signup Scout joins)', async () => {
    const stale = await Pod.findById(pod._id);

    await finishWorkspaceOnboarding(pod, owner._id, 'en');
    const scout = await User.findOne({ isBot: true, _id: { $in: (await Pod.findById(pod._id)).members } });
    expect(scout).toBeTruthy();

    await expectStaleSaveRefused(stale, other._id, pod._id, scout._id);
  });

  it('ensureGlobalSocialFeedPod (a second admin joins)', async () => {
    await Pod.deleteMany({ name: 'Global Social Feed' });
    const feed = await Pod.create({
      name: 'Global Social Feed', type: 'chat', createdBy: owner._id, members: [owner._id, other._id],
    });
    const secondAdmin = await makeUser({ role: 'admin' });
    const stale = await Pod.findById(feed._id);

    await ensureGlobalSocialFeedPod(secondAdmin._id);

    await expectStaleSaveRefused(stale, other._id, feed._id, secondAdmin._id);
  });
});
