process.env.PG_HOST = '';
const podController = require('../../../controllers/podController');
const Pod = require('../../../models/Pod');
const Message = require('../../../models/Message');
const Post = require('../../../models/Post');
const Summary = require('../../../models/Summary');
const PodAsset = require('../../../models/PodAsset');
const Integration = require('../../../models/Integration');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const AgentIdentityService = require('../../../services/agentIdentityService');
const User = require('../../../models/User');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Message');
jest.mock('../../../models/Post', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/Summary', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ deleteMany: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    findOne: jest.fn(),
    create: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    isInstalled: jest.fn(),
    install: jest.fn(),
    deleteMany: jest.fn(),
  },
}));
jest.mock('../../../models/AgentProfile', () => ({
  updateOne: jest.fn(),
  deleteMany: jest.fn(),
}));
jest.mock('../../../services/dmService', () => ({
  __esModule: true,
  default: { canViewPod: jest.fn() },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
  // joinPod does `require('../services/agentIdentityService').DM_POD_TYPES_GUARD`
  // at runtime to enforce ADR-001 §3.10 (no third-party joins on DM pods).
  // Mirror the production set so the test exercises the real guard.
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']),
}));

describe('podController', () => {
  beforeEach(() => {
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });
  });

  afterEach(() => jest.clearAllMocks());

  it('getPodsByType returns 400 for invalid type', async () => {
    const req = { params: { type: 'invalid' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodsByType(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('getPodsByType allows agent-ensemble', async () => {
    const req = { params: { type: 'agent-ensemble' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const sort = jest.fn().mockResolvedValue([]);
    const populateSecond = jest.fn(() => ({ sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });

    await podController.getPodsByType(req, res);

    expect(Pod.find).toHaveBeenCalledWith({ type: 'agent-ensemble' });
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('createPod accepts agent-ensemble type', async () => {
    // Opt in to the default-agent auto-install for this test.
    process.env.AUTO_INSTALL_DEFAULT_AGENT = '1';
    const savedPod = { _id: 'p1', populate: jest.fn().mockResolvedValue() };
    const save = jest.fn().mockResolvedValue(savedPod);
    Pod.mockImplementation(() => ({ save }));
    AgentRegistry.findOne.mockResolvedValue({
      agentName: 'commonly-bot',
      latestVersion: '1.0.0',
      displayName: 'Commonly Bot',
      manifest: { context: { required: ['context:read'] } },
    });
    AgentInstallation.isInstalled.mockResolvedValue(false);
    AgentInstallation.install.mockResolvedValue({
      displayName: 'Commonly Bot',
      instanceId: 'default',
    });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: 'agent-1' });
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(savedPod);

    const req = {
      body: { name: 'Ensemble Pod', description: 'AI pod', type: 'agent-ensemble' },
      userId: 'creator',
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

    try {
      await podController.createPod(req, res);
    } finally {
      delete process.env.AUTO_INSTALL_DEFAULT_AGENT;
    }

    expect(save).toHaveBeenCalled();
    expect(savedPod.populate).toHaveBeenCalledWith('createdBy', 'username profilePicture');
    expect(savedPod.populate).toHaveBeenCalledWith('members', 'username profilePicture isBot');
    expect(AgentInstallation.install).toHaveBeenCalledWith('commonly-bot', 'p1', expect.objectContaining({
      installedBy: 'creator',
      instanceId: 'default',
    }));
    expect(AgentProfile.updateOne).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(savedPod);
  });

  // ADR-016 enforcement gap, found reviewing #802 (2026-08-04): every DM guard
  // in the codebase is an ENTRANCE guard (join, invite create, invite redeem,
  // install) and none covered creation — so this endpoint minted one-member
  // agent-room pods with a 200, which no later guard can repair.
  it('createPod refuses DM pod types and creates nothing', async () => {
    const save = jest.fn();
    Pod.mockImplementation(() => ({ save }));
    const req = {
      body: { name: 'Sneaky Room', type: 'agent-room' },
      userId: 'creator',
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

    await podController.createPod(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'dm_pod_not_creatable' }));
    // The refusal must also not write: a 400 that still saved would be the
    // exact defect this guard exists to prevent.
    expect(Pod).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('createPod still accepts ordinary room types', async () => {
    const savedPod = { _id: 'p-chat', populate: jest.fn().mockResolvedValue() };
    const save = jest.fn().mockResolvedValue(savedPod);
    Pod.mockImplementation(() => ({ save }));
    const req = { body: { name: 'Normal Room', type: 'chat' }, userId: 'creator' };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

    await podController.createPod(req, res);

    expect(save).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(savedPod);
  });

  // The guard is deliberately NOT implemented by narrowing VALID_POD_TYPES,
  // because that constant is also the read filter for getPodsByType. This
  // pins the separation: refusing to CREATE agent-room must not stop READING
  // the agent-room pods that the DM rail legitimately created.
  it('getPodsByType still serves agent-room after the creation guard', async () => {
    const req = { params: { type: 'agent-room' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const sort = jest.fn().mockResolvedValue([]);
    const populateSecond = jest.fn(() => ({ sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });

    await podController.getPodsByType(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(Pod.find).toHaveBeenCalledWith({ type: 'agent-room' });
  });

  it('createPod does NOT auto-install commonly-bot by default (opt-in via AUTO_INSTALL_DEFAULT_AGENT=1)', async () => {
    // Regression: pre-beta this defaulted ON, which put the summarizer bot
    // into the member list of every UI-created pod — including real users'
    // private pods — with a posting-authorized AgentInstallation.
    delete process.env.AUTO_INSTALL_DEFAULT_AGENT;
    const savedPod = { _id: 'p1', populate: jest.fn().mockResolvedValue() };
    const save = jest.fn().mockResolvedValue(savedPod);
    Pod.mockImplementation(() => ({ save }));

    const req = {
      body: { name: 'User Pod', description: 'private', type: 'chat' },
      userId: 'creator',
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };

    await podController.createPod(req, res);

    expect(AgentInstallation.install).not.toHaveBeenCalled();
    expect(AgentIdentityService.ensureAgentInPod).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(savedPod);
  });

  it('deletePod denies delete if user is not creator', async () => {
    Pod.findById.mockResolvedValue({ createdBy: 'creator' });
    const req = { params: { id: 'p1' }, userId: 'other' };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    await podController.deletePod(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('deletePod allows global admin to delete pod they did not create', async () => {
    Pod.findById.mockResolvedValue({ createdBy: 'creator' });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ role: 'admin' }),
      }),
    });
    Pod.deleteOne.mockResolvedValue({ deletedCount: 1 });
    Message.deleteMany.mockResolvedValue({ deletedCount: 2 });
    Post.deleteMany.mockResolvedValue({ deletedCount: 0 });
    Summary.deleteMany.mockResolvedValue({ deletedCount: 0 });
    PodAsset.deleteMany.mockResolvedValue({ deletedCount: 0 });
    Integration.deleteMany.mockResolvedValue({ deletedCount: 0 });
    AgentInstallation.deleteMany.mockResolvedValue({ deletedCount: 0 });
    AgentProfile.deleteMany.mockResolvedValue({ deletedCount: 0 });

    const req = { params: { id: 'p1' }, userId: 'global-admin' };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };

    await podController.deletePod(req, res);

    expect(Message.deleteMany).toHaveBeenCalledWith({ podId: 'p1' });
    expect(Pod.deleteOne).toHaveBeenCalledWith({ _id: 'p1' });
    expect(res.json).toHaveBeenCalledWith({ msg: 'Pod deleted' });
  });

  it('removeMember denies removal when user is not creator', async () => {
    Pod.findById.mockResolvedValue({
      createdBy: 'creator',
      members: ['creator', 'member'],
    });
    const req = { params: { id: 'p1', memberId: 'member' }, userId: 'other' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.removeMember(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('removeMember blocks removing creator', async () => {
    Pod.findById.mockResolvedValue({
      createdBy: 'creator',
      members: ['creator'],
    });
    const req = { params: { id: 'p1', memberId: 'creator' }, userId: 'creator' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.removeMember(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('removeMember removes member and returns updated pod', async () => {
    const pod = {
      createdBy: 'creator',
      members: ['creator', 'member'],
      save: jest.fn(),
      populate: jest.fn().mockResolvedValue(),
    };
    Pod.findById.mockResolvedValue(pod);
    const req = { params: { id: 'p1', memberId: 'member' }, userId: 'creator' };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await podController.removeMember(req, res);
    expect(pod.members).toEqual(['creator']);
    expect(pod.save).toHaveBeenCalled();
    expect(pod.populate).toHaveBeenCalledWith('createdBy', 'username profilePicture');
    expect(pod.populate).toHaveBeenCalledWith('members', 'username profilePicture isBot');
    expect(res.json).toHaveBeenCalledWith(pod);
  });

  // ── ADR-001 §3.10: agent-rooms are 1:1 DMs ──────────────────────────────

  it('joinPod rejects a third-person join on agent-room with 403', async () => {
    const pod = {
      _id: 'agent-room-1',
      type: 'agent-room',
      members: ['agent-id', 'user-a-id'],
      createdBy: { toString: () => 'agent-id' },
      joinPolicy: 'invite-only',
      save: jest.fn(),
    };
    Pod.findById.mockResolvedValue(pod);
    const req = { params: { id: 'agent-room-1' }, userId: 'user-b-id', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.joinPod(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringMatching(/1:1.*third-person/i) }),
    );
    expect(Pod.updateOne).not.toHaveBeenCalled();
  });

  it('joinPod atomically joins a listed, open chat pod', async () => {
    const pod = {
      _id: 'chat-1',
      type: 'chat',
      members: [
        { toString: () => 'creator-id' },
      ],
      createdBy: { toString: () => 'creator-id' },
      joinPolicy: 'open',
      publicRead: true,
      communityListed: true,
    };
    Pod.findById
      .mockResolvedValueOnce(pod)
      .mockReturnValueOnce({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue({ ...pod, members: [...pod.members, 'new-user-id'] }),
        }),
      });
    const req = { params: { id: 'chat-1' }, userId: 'new-user-id', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.joinPod(req, res);
    expect(Pod.updateOne).toHaveBeenCalledWith(
      { _id: 'chat-1' },
      {
        $addToSet: { members: 'new-user-id' },
        $set: { updatedAt: expect.any(Date) },
      },
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('getPodsByType filters agent-room to caller membership for non-admins', async () => {
    const otherPod = { _id: 'p1', type: 'agent-room', members: [{ _id: 'agent-id' }, { _id: 'someone-else' }] };
    const myPod = { _id: 'p2', type: 'agent-room', members: [{ _id: 'agent-id' }, { _id: 'me' }] };
    const sort = jest.fn().mockResolvedValue([otherPod, myPod]);
    const populateSecond = jest.fn(() => ({ sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ role: 'user' }) }),
    });

    const req = { params: { type: 'agent-room' }, userId: 'me', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodsByType(req, res);
    expect(res.json).toHaveBeenCalledWith([myPod]);
  });

  it('getPodsByType filters agent-room to caller membership even for global admins', async () => {
    // Regression: admins used to bypass membership and see every private DM
    // in the instance in their sidebar. That leaked other users' rooms and
    // produced the "Talk to → can't post" UX bug. Admins now see only
    // their own personal pods on this listing; moderation goes via a
    // dedicated admin tool, not this generic endpoint.
    const otherPod = { _id: 'p1', type: 'agent-room', members: [{ _id: 'agent-id' }, { _id: 'someone-else' }] };
    const myPod = { _id: 'p2', type: 'agent-room', members: [{ _id: 'agent-id' }, { _id: 'admin-id' }] };
    const sort = jest.fn().mockResolvedValue([otherPod, myPod]);
    const populateSecond = jest.fn(() => ({ sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ role: 'admin' }) }),
    });

    const req = { params: { type: 'agent-room' }, userId: 'admin-id', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodsByType(req, res);
    expect(res.json).toHaveBeenCalledWith([myPod]);
  });

  it('getAllPods default scope=mine filters to caller membership even for admins', async () => {
    const otherPod = { _id: 'p1', type: 'chat', members: [{ _id: 'someone-else' }] };
    const myPod = { _id: 'p2', type: 'chat', members: [{ _id: 'admin-id' }] };
    const sort = jest.fn().mockResolvedValue([otherPod, myPod]);
    const populateThird = jest.fn(() => ({ sort }));
    const populateSecond = jest.fn(() => ({ populate: populateThird, sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ role: 'admin' }) }),
    });

    const req = { query: {}, userId: 'admin-id', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getAllPods(req, res);
    expect(Pod.find).toHaveBeenCalledWith({ type: { $ne: 'agent-admin' } });
    // Default scope=mine: admin is filtered to their own pods, NOT every
    // chat pod in the instance.
    expect(res.json).toHaveBeenCalledWith([myPod]);
  });

  it('getAllPods community scope requires listed, readable member pods', async () => {
    const sort = jest.fn().mockResolvedValue([]);
    const populateThird = jest.fn(() => ({ sort }));
    const populateSecond = jest.fn(() => ({ populate: populateThird, sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });

    const communityUserId = '507f1f77bcf86cd799439011';
    const req = { query: { scope: 'community' }, userId: communityUserId, user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getAllPods(req, res);

    expect(Pod.find).toHaveBeenCalledWith({
      publicRead: true,
      communityListed: true,
      members: expect.anything(),
      type: { $nin: ['agent-room', 'agent-dm', 'agent-admin'] },
    });
    const [query] = Pod.find.mock.calls[0];
    expect(String(query.members)).toBe(communityUserId);
  });

  it('getAllPods discover scope requires listed, readable, joinable non-member pods', async () => {
    const sort = jest.fn().mockResolvedValue([]);
    const populateThird = jest.fn(() => ({ sort }));
    const populateSecond = jest.fn(() => ({ populate: populateThird, sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });

    const discoverUserId = '507f1f77bcf86cd799439011';
    const req = { query: { scope: 'discover' }, userId: discoverUserId, user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getAllPods(req, res);

    expect(Pod.find).toHaveBeenCalledWith({
      publicRead: true,
      communityListed: true,
      joinPolicy: { $ne: 'invite-only' },
      members: { $ne: expect.anything() },
      type: { $nin: ['agent-room', 'agent-dm', 'agent-admin'] },
    });
    const [query] = Pod.find.mock.calls[0];
    expect(String(query.members.$ne)).toBe(discoverUserId);
  });

  it('getAllPods scope=all returns everything for admins (explicit moderation view)', async () => {
    const otherPod = { _id: 'p1', type: 'chat', members: [{ _id: 'someone-else' }] };
    const myPod = { _id: 'p2', type: 'chat', members: [{ _id: 'admin-id' }] };
    const sort = jest.fn().mockResolvedValue([otherPod, myPod]);
    const populateThird = jest.fn(() => ({ sort }));
    const populateSecond = jest.fn(() => ({ populate: populateThird, sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ role: 'admin' }) }),
    });

    const req = { query: { scope: 'all' }, userId: 'admin-id', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getAllPods(req, res);
    expect(res.json).toHaveBeenCalledWith([otherPod, myPod]);
  });

  it('getAllPods scope=all is silently downgraded to scope=mine for non-admins', async () => {
    const otherPod = { _id: 'p1', type: 'chat', members: [{ _id: 'someone-else' }] };
    const myPod = { _id: 'p2', type: 'chat', members: [{ _id: 'me' }] };
    const sort = jest.fn().mockResolvedValue([otherPod, myPod]);
    const populateThird = jest.fn(() => ({ sort }));
    const populateSecond = jest.fn(() => ({ populate: populateThird, sort }));
    const populateFirst = jest.fn(() => ({ populate: populateSecond, sort }));
    Pod.find.mockReturnValue({ populate: populateFirst });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ role: 'user' }) }),
    });

    const req = { query: { scope: 'all' }, userId: 'me', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getAllPods(req, res);
    expect(res.json).toHaveBeenCalledWith([myPod]);
  });

  it('getPodById returns 404 for personal pod types when caller is not a member', async () => {
    const pod = {
      _id: 'agent-room-1',
      type: 'agent-room',
      members: [{ _id: 'agent-id' }, { _id: 'someone-else' }],
    };
    Pod.findById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(pod),
        }),
      }),
    });
    const req = { params: { id: 'agent-room-1' }, userId: 'me', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodById(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('getPodById returns the pod for personal pod types when caller IS a member', async () => {
    const pod = {
      _id: 'agent-room-1',
      type: 'agent-room',
      members: [{ _id: 'agent-id' }, { _id: 'me' }],
    };
    Pod.findById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(pod),
        }),
      }),
    });
    const req = { params: { id: 'agent-room-1' }, userId: 'me', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodById(req, res);
    expect(res.json).toHaveBeenCalledWith(pod);
  });

  // ── Gap 2 (PR #381): agent-dm §3.7 fan-out carve-out for direct ID lookup ─
  // PR #375 made getPodById 404 non-members of all personal pod types so
  // admins couldn't accidentally land in someone else's DM via the sidebar.
  // But agent-dm specifically has §3.7 fan-out: humans who share a pod with
  // either DM member can observe (canViewPod returns true). Without this
  // carve-out, V2's "Direct messages" list in the inspector navigates to
  // /v2/pods/<a2a-dm-id> and the layout 404s — user reports "clicking the
  // DM row doesn't open the pod." Carve-out is agent-dm only — agent-room
  // (user↔agent) and agent-admin (ops) keep strict membership.
  it('getPodById allows agent-dm read when canViewPod (§3.7 fan-out) allows', async () => {
    const DMService = require('../../../services/dmService').default;
    DMService.canViewPod.mockResolvedValueOnce(true);

    const pod = {
      _id: 'a2a-dm-1',
      type: 'agent-dm',
      members: [{ _id: 'agent-a' }, { _id: 'agent-b' }],
    };
    Pod.findById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(pod),
        }),
      }),
    });
    const req = {
      params: { id: 'a2a-dm-1' },
      userId: 'observer-human',
      user: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodById(req, res);
    expect(res.json).toHaveBeenCalledWith(pod);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it('getPodById still 404s agent-dm when canViewPod denies (no shared pod, not admin)', async () => {
    const DMService = require('../../../services/dmService').default;
    DMService.canViewPod.mockResolvedValueOnce(false);

    const pod = {
      _id: 'a2a-dm-2',
      type: 'agent-dm',
      members: [{ _id: 'agent-a' }, { _id: 'agent-b' }],
    };
    Pod.findById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(pod),
        }),
      }),
    });
    const req = {
      params: { id: 'a2a-dm-2' },
      userId: 'stranger',
      user: {},
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodById(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('getPodById keeps strict membership 404 for agent-room (no §3.7 fan-out)', async () => {
    const pod = {
      _id: 'agent-room-x',
      type: 'agent-room',
      members: [{ _id: 'agent-id' }, { _id: 'someone-else' }],
    };
    Pod.findById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(pod),
        }),
      }),
    });
    const req = { params: { id: 'agent-room-x' }, userId: 'observer', user: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await podController.getPodById(req, res);
    // agent-room never gets the §3.7 carve-out — strict membership only.
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
