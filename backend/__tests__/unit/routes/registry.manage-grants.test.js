const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const id = req.get('x-test-user');
  if (!id) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = id;
  req.user = { id, role: req.get('x-test-role') || 'user' };
  return next();
});
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
jest.mock('../../../models/RoomGrant', () => ({ find: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({ buildAgentUsername: () => 'agent-nib' }));
jest.mock('../../../routes/registry/helpers', () => ({
  getUserId: (req) => req.userId,
  isGlobalAdminUser: async () => false,
  normalizeInstanceId: (id) => id || 'default',
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const RoomGrant = require('../../../models/RoomGrant');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');

const app = express();
app.use('/api/registry', require('../../../routes/registry/manage-grants'));
const URL = '/api/registry/agents/nib/instances/default/grants';

beforeEach(() => {
  jest.clearAllMocks();
  AgentInstallation.find.mockReturnValue({ lean: async () => [{
    agentName: 'nib', instanceId: 'default', installedBy: 'owner', podId: 'pod-1',
  }] });
  User.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: 'agent-1' }) }) });
  RoomGrant.find.mockReturnValue({ sort: () => ({ lean: async () => [{
    grantId: 'grant-1', connectionId: 'connection-1', target: { kind: 'pod', id: 'pod-1' },
    audience: ['agent-1'], tools: ['linear.list_issues'], createdAt: new Date('2026-10-01'),
    expiresAt: new Date('2026-11-01'), revokedAt: null, ownerId: 'owner', connectionRowId: 'conn-row-1',
  }] }) });
  Pod.find.mockReturnValue({ select: () => ({ lean: async () => [{
    _id: 'pod-1', name: 'Work', members: ['agent-1'],
  }] }) });
  Integration.findById.mockReturnValue({ select: () => ({ lean: async () => null }) });
  Integration.findOne.mockReturnValue({ select: () => ({ lean: async () => ({
    type: 'hosted-mcp', config: { entryId: 'linear' }, createdBy: 'owner',
  }) }) });
  User.find.mockReturnValue({ select: () => ({ lean: async () => [{
    _id: 'owner', displayName: 'Owner', username: 'owner',
  }] }) });
});

test('only the installer or an instance admin can read an agent grants', async () => {
  const denied = await request(app).get(URL).set('x-test-user', 'member');
  expect(denied.status).toBe(403);
  expect(RoomGrant.find).not.toHaveBeenCalled();

  const owner = await request(app).get(URL).set('x-test-user', 'owner');
  expect(owner.status).toBe(200);
  expect(owner.body.grants).toMatchObject([{
    grantId: 'grant-1', connector: 'linear', podName: 'Work', grantedBy: 'Owner',
    canRevoke: true,
  }]);

  const admin = await request(app).get(URL).set('x-test-user', 'admin').set('x-test-role', 'admin');
  expect(admin.status).toBe(200);
  expect(admin.body.grants[0].canRevoke).toBe(true);
});

test('a second installer cannot inspect a shared identity through their row', async () => {
  AgentInstallation.find.mockReturnValue({ lean: async () => [
    { installedBy: 'owner', status: 'active', config: {} },
    { installedBy: 'someone-else', status: 'paused', config: {} },
  ] });
  const res = await request(app).get(URL).set('x-test-user', 'owner');
  expect(res.status).toBe(403);
  expect(RoomGrant.find).not.toHaveBeenCalled();
  expect(AgentInstallation.find).toHaveBeenCalledWith({
    agentName: 'nib', instanceId: 'default', status: { $ne: 'uninstalled' },
  });
});

test('a paused-only installer can read their agent grants', async () => {
  AgentInstallation.find.mockReturnValue({ lean: async () => [
    { installedBy: 'owner', status: 'paused', config: {} },
  ] });
  const res = await request(app).get(URL).set('x-test-user', 'owner');
  expect(res.status).toBe(200);
  expect(res.body.grants).toHaveLength(1);
});

test('a grant for a pod the agent left does not appear as current access', async () => {
  Pod.find.mockReturnValue({ select: () => ({ lean: async () => [{
    _id: 'pod-1', name: 'Work', members: ['someone-else'],
  }] }) });
  const res = await request(app).get(URL).set('x-test-user', 'owner');
  expect(res.status).toBe(200);
  expect(res.body.grants).toEqual([]);
});

test('the granter and revoke right come from the binding, not the connection row', async () => {
  // A row with no createdBy still belongs to the bound owner; the binding decides.
  Integration.findOne.mockReturnValue({ select: () => ({ lean: async () => ({
    type: 'hosted-mcp', config: { entryId: 'linear', linkedUserId: 'owner' },
  }) }) });
  const res = await request(app).get(URL).set('x-test-user', 'owner');
  expect(res.status).toBe(200);
  expect(res.body.grants[0]).toMatchObject({ grantedBy: 'Owner', canRevoke: true });
});

test('after the connection changed hands, the page still names the bound owner, not the new holder', async () => {
  Integration.findOne.mockReturnValue({ select: () => ({ lean: async () => ({
    type: 'hosted-mcp', config: { entryId: 'linear' }, createdBy: 'stranger',
  }) }) });
  User.find.mockReturnValue({ select: () => ({ lean: async () => [
    { _id: 'owner', displayName: 'Owner', username: 'owner' },
    { _id: 'stranger', displayName: 'Stranger', username: 'stranger' },
  ] }) });
  const holder = await request(app).get(URL).set('x-test-user', 'owner');
  expect(holder.body.grants[0]).toMatchObject({ grantedBy: 'Owner', canRevoke: true });
  const stranger = await request(app).get(URL).set('x-test-user', 'stranger');
  expect(stranger.status).toBe(403);
});

test('an unbound grant is shown without a granter and is revocable by an admin only', async () => {
  RoomGrant.find.mockReturnValue({ sort: () => ({ lean: async () => [{
    grantId: 'grant-2', connectionId: 'connection-1', target: { kind: 'pod', id: 'pod-1' },
    audience: ['agent-1'], tools: ['linear.list_issues'], createdAt: new Date('2026-10-01'),
    expiresAt: new Date('2026-11-01'), revokedAt: null, ownerId: null, connectionRowId: null,
  }] }) });
  const owner = await request(app).get(URL).set('x-test-user', 'owner');
  expect(owner.body.grants[0]).toMatchObject({ grantedBy: null, canRevoke: false });
  const admin = await request(app).get(URL).set('x-test-user', 'admin').set('x-test-role', 'admin');
  expect(admin.body.grants[0]).toMatchObject({ grantedBy: null, canRevoke: true });
});
