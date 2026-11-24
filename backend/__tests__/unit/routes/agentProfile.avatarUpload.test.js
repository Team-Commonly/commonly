/**
 * An agent's avatar takes only an upload its installer can read (F609).
 *
 * The same rule the person-profile writers apply (userController.updateProfile,
 * authController.updateProfilePicture): a value that points at a pod-scoped
 * upload someone else made is refused with 400 `avatar_not_own_upload`. The
 * check runs as the CALLER, the human making the request, not as the agent.
 */

jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/AgentMemory', () => ({}));
jest.mock('../../../models/AgentProfile', () => ({}));
jest.mock('../../../models/AgentRun', () => ({}));
jest.mock('../../../models/PodAsset', () => ({}));
jest.mock('../../../models/pg/Message', () => ({}));
jest.mock('../../../models/File', () => ({ findByFileName: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
  AgentRegistry: { updateOne: jest.fn() },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentDisplayLabel: jest.fn((u, f) => f),
  syncUserToPostgreSQL: jest.fn(),
}));
// Route suites mock the auth middleware and call handlers directly.
jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => next()));

const User = require('../../../models/User');
const File = require('../../../models/File');
const { AgentInstallation, AgentRegistry } = require('../../../models/AgentRegistry');
const AgentIdentityService = require('../../../services/agentIdentityService');
const router = require('../../../routes/agentProfile');

const layer = router.stack.find((entry) => (
  entry.route && entry.route.path === '/:agentName/:instanceId?/avatar' && entry.route.methods.put
));
const putAvatar = layer.route.stack[layer.route.stack.length - 1].handle;

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

const reqFor = (avatar, user = { id: 'owner-1', role: 'user' }) => ({
  params: { agentName: 'theo', instanceId: 'default' },
  body: { avatar },
  userId: user.id,
  user,
});

describe('agent avatar upload references (F609)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'inst-1' }) }),
    });
    User.findOneAndUpdate.mockResolvedValue({ _id: 'bot-1' });
    AgentRegistry.updateOne.mockResolvedValue({});
    AgentIdentityService.syncUserToPostgreSQL.mockResolvedValue(undefined);
    File.findByFileName.mockResolvedValue(null);
  });

  it("refuses an installer's pick of a pod upload someone else made", async () => {
    File.findByFileName.mockResolvedValue({ uploadedBy: 'someone-else', podId: 'pod-1' });
    const res = response();

    await putAvatar(reqFor('/api/uploads/user-x-1-pod.png'), res);

    expect(File.findByFileName).toHaveBeenCalledWith('user-x-1-pod.png');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'A profile picture has to be your own upload.',
      code: 'avatar_not_own_upload',
    });
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(AgentRegistry.updateOne).not.toHaveBeenCalled();
  });

  it('refuses the same pick in its absolute-URL form', async () => {
    File.findByFileName.mockResolvedValue({ uploadedBy: 'someone-else', podId: 'pod-1' });
    const res = response();

    await putAvatar(reqFor('https://api.commonly.me/api/uploads/user-x-1-pod.png'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'avatar_not_own_upload' }));
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('checks as the calling admin, not as the agent', async () => {
    File.findByFileName.mockResolvedValue({ uploadedBy: 'someone-else', podId: 'pod-1' });
    const res = response();

    await putAvatar(reqFor('/api/uploads/user-x-1-pod.png', { id: 'admin-1', role: 'admin' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("accepts the caller's own un-scoped upload", async () => {
    File.findByFileName.mockResolvedValue({ uploadedBy: 'owner-1', podId: null });
    const res = response();

    await putAvatar(reqFor('/api/uploads/my-icon.png'), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(), { $set: { profilePicture: '/api/uploads/my-icon.png' } }, { new: true },
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true, avatar: '/api/uploads/my-icon.png' });
  });

  it('accepts a pod-scoped upload the caller made', async () => {
    File.findByFileName.mockResolvedValue({ uploadedBy: 'owner-1', podId: 'pod-1' });
    const res = response();

    await putAvatar(reqFor('/api/uploads/mine-in-pod.png'), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, avatar: '/api/uploads/mine-in-pod.png' });
  });

  it('accepts an upload reference with no File row, as before', async () => {
    const res = response();

    await putAvatar(reqFor('/api/uploads/legacy-icon.png'), res);

    expect(res.json).toHaveBeenCalledWith({ ok: true, avatar: '/api/uploads/legacy-icon.png' });
  });

  it('accepts a bottts preset without looking up any file', async () => {
    const res = response();

    await putAvatar(reqFor('bottts:theo:v3'), res);

    expect(File.findByFileName).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, avatar: 'bottts:theo:v3' });
  });
});
