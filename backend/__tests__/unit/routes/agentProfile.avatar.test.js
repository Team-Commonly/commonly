/**
 * Owner-editable agent avatar (Sam, 2026-08-20).
 *
 * The gate is creation-shaped: the caller must be an admin or the installer of
 * an ACTIVE installation of this agent. These tests pin the gate and the write
 * order — Mongo User first (source of truth), then the PG mirror through the
 * ONE sanctioned door (syncUserToPostgreSQL), then AgentRegistry.iconUrl so
 * the Your-Team cards can't drift from the profile.
 */

jest.mock('../../../models/User', () => ({
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/AgentMemory', () => ({}));
jest.mock('../../../models/AgentRun', () => ({}));
jest.mock('../../../models/PodAsset', () => ({}));
jest.mock('../../../models/pg/Message', () => ({}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn() },
  AgentRegistry: { updateOne: jest.fn() },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentDisplayLabel: jest.fn((u, f) => f),
  syncUserToPostgreSQL: jest.fn(),
}));
// jsonwebtoken crashes under Node 26 in jest (buffer-equal-constant-time);
// route suites mock the middleware and call handlers directly.
jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => next()));

const User = require('../../../models/User');
const { AgentInstallation, AgentRegistry } = require('../../../models/AgentRegistry');
const AgentIdentityService = require('../../../services/agentIdentityService');
const router = require('../../../routes/agentProfile');

const getHandler = (method, path) => {
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});

const installationLookup = (result) => {
  AgentInstallation.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
  });
};

const putAvatar = getHandler('put', '/:agentName/:instanceId?/avatar');
const canEdit = getHandler('get', '/:agentName/:instanceId?/avatar/can-edit');

describe('agent avatar editing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findOneAndUpdate.mockResolvedValue({ _id: 'bot-1', profilePicture: 'bottts:theo:v3' });
    AgentRegistry.updateOne.mockResolvedValue({});
    AgentIdentityService.syncUserToPostgreSQL.mockResolvedValue(undefined);
  });

  const reqFor = (user, avatar = 'bottts:theo:default-v3') => ({
    params: { agentName: 'theo', instanceId: 'default' },
    body: { avatar },
    userId: user.id,
    user,
  });

  it('lets the installer of an active installation update the avatar', async () => {
    installationLookup({ _id: 'inst-1' });
    const res = response();

    await putAvatar(reqFor({ id: 'owner-1', role: 'user' }), res);

    // The gate queried for THIS caller's active installation of THIS agent.
    expect(AgentInstallation.findOne).toHaveBeenCalledWith({
      agentName: 'theo', instanceId: 'default', status: 'active', installedBy: 'owner-1',
    });
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      { isBot: true, 'botMetadata.agentName': 'theo', 'botMetadata.instanceId': 'default' },
      { $set: { profilePicture: 'bottts:theo:default-v3' } },
      { new: true },
    );
    // Both downstream surfaces moved in the same request.
    expect(AgentIdentityService.syncUserToPostgreSQL).toHaveBeenCalled();
    expect(AgentRegistry.updateOne).toHaveBeenCalledWith(
      { agentName: 'theo' }, { $set: { iconUrl: 'bottts:theo:default-v3' } },
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true, avatar: 'bottts:theo:default-v3' });
  });

  it('403s a stranger without touching any store', async () => {
    installationLookup(null);
    const res = response();

    await putAvatar(reqFor({ id: 'stranger-9', role: 'user' }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(AgentRegistry.updateOne).not.toHaveBeenCalled();
  });

  it('lets an admin edit without owning an installation', async () => {
    const res = response();

    await putAvatar(reqFor({ id: 'admin-1', role: 'admin' }), res);

    expect(AgentInstallation.findOne).not.toHaveBeenCalled();
    expect(User.findOneAndUpdate).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('400s anything that is not a bottts preset or an upload reference', async () => {
    const res = response();
    // AI-generation URLs, data URIs, and the human face scheme are all invalid
    // here — agents are robots, and raw generation is deprecated.
    for (const bad of ['bigsmile:sam-v1', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '']) {
      await putAvatar(reqFor({ id: 'admin-1', role: 'admin' }, bad), res);
    }
    expect(res.status).toHaveBeenCalledTimes(4);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts an uploaded-image reference', async () => {
    const res = response();
    await putAvatar(reqFor({ id: 'admin-1', role: 'admin' }, '/api/uploads/custom-icon.png'), res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, avatar: '/api/uploads/custom-icon.png' });
  });

  it('404s when no bot User row matches the identity', async () => {
    User.findOneAndUpdate.mockResolvedValue(null);
    const res = response();
    await putAvatar(reqFor({ id: 'admin-1', role: 'admin' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(AgentRegistry.updateOne).not.toHaveBeenCalled();
  });

  it('still succeeds when the PG mirror write fails — Mongo is the source of truth', async () => {
    AgentIdentityService.syncUserToPostgreSQL.mockRejectedValue(new Error('pg down'));
    const res = response();
    await putAvatar(reqFor({ id: 'admin-1', role: 'admin' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('can-edit reports the same verdict the write path enforces', async () => {
    installationLookup({ _id: 'inst-1' });
    const yes = response();
    await canEdit(reqFor({ id: 'owner-1', role: 'user' }), yes);
    expect(yes.json).toHaveBeenCalledWith({ canEdit: true });

    installationLookup(null);
    const no = response();
    await canEdit(reqFor({ id: 'stranger-9', role: 'user' }), no);
    expect(no.json).toHaveBeenCalledWith({ canEdit: false });
  });
});
