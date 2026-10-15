const request = require('supertest');
const express = require('express');

const mockInstallationFind = jest.fn();
const mockUserFind = jest.fn();

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: mockInstallationFind },
}));

jest.mock('../../../models/User', () => ({
  find: mockUserFind,
}));

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: jest.fn((agentName) => agentName.toLowerCase()),
}));

jest.mock('../../../controllers/userController', () => ({
  getCurrentProfile: jest.fn(),
  updateProfile: jest.fn(),
  getUserById: jest.fn(),
  getUserPublicActivity: jest.fn(),
  followUser: jest.fn(),
  unfollowUser: jest.fn(),
}));

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (req.header('Authorization') !== 'Bearer human-token') {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }
  req.userId = 'human-1';
  return next();
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const routes = require('../../../routes/users');

const query = (value) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(value),
  }),
});

describe('GET /api/users/me/agent-connection', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/users', routes);

  beforeEach(() => {
    jest.clearAllMocks();
    mockInstallationFind.mockReturnValue(query([]));
    mockUserFind.mockReturnValue(query([]));
  });

  it('requires human authentication', async () => {
    const res = await request(app).get('/api/users/me/agent-connection');

    expect(res.status).toBe(401);
    expect(mockInstallationFind).not.toHaveBeenCalled();
  });

  it('reports an unissued connection when the user has no active agent installations', async () => {
    const res = await request(app)
      .get('/api/users/me/agent-connection')
      .set('Authorization', 'Bearer human-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issued: false,
      connected: false,
      lastUsedAt: null,
      connectedAgent: null,
    });
    expect(res.headers).toHaveProperty('ratelimit-policy');
    expect(mockInstallationFind).toHaveBeenCalledWith({ installedBy: 'human-1', status: 'active' });
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('reports an owned active installation that has not connected yet', async () => {
    mockInstallationFind.mockReturnValue(query([
      { agentName: 'OpenClaw', instanceId: 'Aria', podId: 'workspace-1' },
    ]));
    mockUserFind.mockReturnValue(query([
      { agentRuntimeTokens: [{ createdAt: new Date('2026-07-21T10:00:00.000Z') }] },
    ]));

    const res = await request(app)
      .get('/api/users/me/agent-connection')
      .set('Authorization', 'Bearer human-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issued: true,
      connected: false,
      lastUsedAt: null,
      connectedAgent: null,
    });
    expect(mockUserFind).toHaveBeenCalledWith({
      isBot: true,
      $or: [{
        'botMetadata.agentName': 'openclaw',
        'botMetadata.instanceId': 'aria',
      }],
    });
  });

  // Signup installs Scout into every new workspace with installedBy = the new
  // user. Counting it made every signup look like they had attached an agent,
  // so the first-run card (which shows only on issued: false) never appeared.
  it('does not count the Scout that signup installed as an agent the person attached', async () => {
    mockInstallationFind.mockReturnValue(query([
      { agentName: 'scout', instanceId: 'u1a2b3c4d5e', podId: 'workspace-1' },
    ]));

    const res = await request(app)
      .get('/api/users/me/agent-connection')
      .set('Authorization', 'Bearer human-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issued: false,
      connected: false,
      lastUsedAt: null,
      connectedAgent: null,
    });
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('counts an agent the person set up alongside their Scout, and only that agent', async () => {
    mockInstallationFind.mockReturnValue(query([
      { agentName: 'scout', instanceId: 'u1a2b3c4d5e', podId: 'workspace-1' },
      { agentName: 'maya-claude', instanceId: 'default', podId: 'workspace-1' },
    ]));
    mockUserFind.mockReturnValue(query([]));

    const res = await request(app)
      .get('/api/users/me/agent-connection')
      .set('Authorization', 'Bearer human-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issued: true,
      connected: false,
      lastUsedAt: null,
      connectedAgent: null,
    });
    expect(mockUserFind).toHaveBeenCalledWith({
      isBot: true,
      $or: [{
        'botMetadata.agentName': 'maya-claude',
        'botMetadata.instanceId': 'default',
      }],
    });
  });

  it('reports the most recent connection without returning token material', async () => {
    mockInstallationFind.mockReturnValue(query([
      { agentName: 'openclaw', instanceId: 'aria', podId: 'workspace-1' },
      { agentName: 'codex', instanceId: 'default', podId: 'workspace-2' },
    ]));
    mockUserFind.mockReturnValue(query([
      {
        botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
        agentRuntimeTokens: [
          { tokenHash: 'never-return-this', lastUsedAt: new Date('2026-07-21T10:00:00.000Z') },
        ],
      },
      {
        botMetadata: { agentName: 'codex', instanceId: 'default' },
        agentRuntimeTokens: [
          { tokenHash: 'or-this', lastUsedAt: new Date('2026-07-21T12:00:00.000Z') },
        ],
      },
    ]));

    const res = await request(app)
      .get('/api/users/me/agent-connection')
      .set('Authorization', 'Bearer human-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issued: true,
      connected: true,
      lastUsedAt: '2026-07-21T12:00:00.000Z',
      connectedAgent: {
        agentName: 'codex',
        instanceId: 'default',
        podId: 'workspace-2',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('token');
    expect(JSON.stringify(res.body)).not.toContain('hash');
  });
});
