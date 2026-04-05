const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  const authHeader = req.header('Authorization');
  if (!authHeader) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  const token = authHeader.replace('Bearer ', '');
  if (token === 'admin-token') {
    req.user = { id: 'admin-user', role: 'admin' };
    req.userId = 'admin-user';
    return next();
  }

  req.user = { id: 'user-1', role: 'member' };
  req.userId = 'user-1';
  return next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => {
  if (req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({ message: 'Admin access required' });
});

jest.mock('../../../models/Integration', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  findByIdAndDelete: jest.fn(),
}));

jest.mock('../../../models/DiscordIntegration', () => ({
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../services/discordService', () => {
  const DiscordService = jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(true),
    registerSlashCommands: jest.fn().mockResolvedValue(true),
  }));
  DiscordService.registerCommandsForAllIntegrations = jest.fn().mockResolvedValue({
    success: true,
  });
  return DiscordService;
});

jest.mock('../../../services/discordMultiCommandService', () => ({
  runDiscordCommandForIntegrations: jest.fn(),
}));

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('tweetnacl', () => ({
  sign: {
    detached: {
      verify: jest.fn(),
    },
  },
}));

const Integration = require('../../../models/Integration');
const DiscordIntegration = require('../../../models/DiscordIntegration');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const DiscordService = require('../../../services/discordService');
const discordRoutes = require('../../../routes/discord');

const app = express();
app.use(express.json());
app.use('/api/discord', discordRoutes);

describe('discord management route auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockImplementation(async (id) => {
      if (id === 'admin-user') {
        return { _id: id, role: 'admin' };
      }
      return { _id: id, role: 'member' };
    });
    Pod.findById.mockResolvedValue({ _id: 'pod-1', createdBy: { toString: () => 'user-1' } });
  });

  it('requires auth for install-link', async () => {
    const res = await request(app).get('/api/discord/install-link/pod-1');

    expect(res.status).toBe(401);
  });

  it('blocks install-link for non-owners', async () => {
    Pod.findById.mockResolvedValue({ _id: 'pod-1', createdBy: { toString: () => 'someone-else' } });

    const res = await request(app)
      .get('/api/discord/install-link/pod-1')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });

  it('requires integration ownership for command registration', async () => {
    Integration.findById.mockResolvedValue({
      _id: 'integration-1',
      type: 'discord',
      podId: 'pod-1',
      createdBy: { toString: () => 'someone-else' },
      config: { serverId: 'guild-1' },
    });
    Pod.findById.mockResolvedValue({ _id: 'pod-1', createdBy: { toString: () => 'someone-else' } });

    const res = await request(app)
      .post('/api/discord/register-commands/integration-1')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(403);
    expect(DiscordService).not.toHaveBeenCalled();
  });

  it('allows pod owners to register commands', async () => {
    Integration.findById.mockResolvedValue({
      _id: 'integration-1',
      type: 'discord',
      podId: 'pod-1',
      createdBy: { toString: () => 'someone-else' },
      config: { serverId: 'guild-1' },
    });

    const res = await request(app)
      .post('/api/discord/register-commands/integration-1')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(200);
    expect(DiscordService).toHaveBeenCalledWith('integration-1');
  });

  it('requires auth and admin access for register-all', async () => {
    const unauthenticated = await request(app).post('/api/discord/register-all');
    expect(unauthenticated.status).toBe(401);

    const forbidden = await request(app)
      .post('/api/discord/register-all')
      .set('Authorization', 'Bearer user-token');
    expect(forbidden.status).toBe(403);

    const admin = await request(app)
      .post('/api/discord/register-all')
      .set('Authorization', 'Bearer admin-token');
    expect(admin.status).toBe(200);
    expect(DiscordService.registerCommandsForAllIntegrations).toHaveBeenCalledTimes(1);
  });

  it('blocks uninstall for users who cannot manage the integration', async () => {
    Integration.findOne.mockResolvedValue({
      _id: 'integration-1',
      installationId: 'install-1',
      podId: 'pod-1',
      createdBy: { toString: () => 'someone-else' },
    });
    Pod.findById.mockResolvedValue({ _id: 'pod-1', createdBy: { toString: () => 'someone-else' } });

    const res = await request(app)
      .delete('/api/discord/uninstall/install-1')
      .set('Authorization', 'Bearer user-token');

    expect(res.status).toBe(403);
    expect(DiscordIntegration.findOneAndDelete).not.toHaveBeenCalled();
  });
});
