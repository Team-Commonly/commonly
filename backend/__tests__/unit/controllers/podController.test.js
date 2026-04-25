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
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
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

    await podController.createPod(req, res);

    expect(save).toHaveBeenCalled();
    expect(savedPod.populate).toHaveBeenCalledWith('createdBy', 'username profilePicture');
    expect(savedPod.populate).toHaveBeenCalledWith('members', 'username profilePicture');
    expect(AgentInstallation.install).toHaveBeenCalledWith('commonly-bot', 'p1', expect.objectContaining({
      installedBy: 'creator',
      instanceId: 'default',
    }));
    expect(AgentProfile.updateOne).toHaveBeenCalled();
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
    expect(pod.populate).toHaveBeenCalledWith('members', 'username profilePicture');
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
    expect(pod.save).not.toHaveBeenCalled();
  });

  it('joinPod still works on regular chat pods (regression guard)', async () => {
    const pod = {
      _id: 'chat-1',
      type: 'chat',
      members: [
        { toString: () => 'creator-id' },
      ],
      createdBy: { toString: () => 'creator-id' },
      joinPolicy: 'open',
      save: jest.fn().mockResolvedValue(undefined),
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
    expect(pod.save).toHaveBeenCalled();
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

  it('getPodsByType returns ALL agent-rooms when caller is a global admin', async () => {
    const otherPod = { _id: 'p1', type: 'agent-room', members: [{ _id: 'agent-id' }, { _id: 'someone-else' }] };
    const myPod = { _id: 'p2', type: 'agent-room', members: [{ _id: 'agent-id' }, { _id: 'me' }] };
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
    // Admin sees both pods, not just their own.
    expect(res.json).toHaveBeenCalledWith([otherPod, myPod]);
  });
});
