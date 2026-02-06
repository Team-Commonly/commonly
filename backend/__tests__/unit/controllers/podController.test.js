process.env.PG_HOST = '';
const podController = require('../../../controllers/podController');
const Pod = require('../../../models/Pod');
const Message = require('../../../models/Message');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const AgentIdentityService = require('../../../services/agentIdentityService');

jest.mock('../../../models/Pod');
jest.mock('../../../models/Message');
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    findOne: jest.fn(),
    create: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    isInstalled: jest.fn(),
    install: jest.fn(),
  },
}));
jest.mock('../../../models/AgentProfile', () => ({
  updateOne: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));

describe('podController', () => {
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
});
