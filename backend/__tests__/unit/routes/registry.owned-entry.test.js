const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { findOne: jest.fn() },
  AgentInstallation: {},
}));

jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AuditLog', () => ({
  create: jest.fn(),
}));

const { AgentRegistry } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const AuditLog = require('../../../models/AuditLog');
const router = require('../../../routes/registry/owned-entry');

const actor = (role) => ({ select: () => ({ lean: async () => ({ role }) }) });

describe('PATCH /agents/:name/owned-entry (TASK-419)', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/registry', router);
    jest.clearAllMocks();
    User.findById.mockReturnValue(actor('user'));
    AuditLog.create.mockResolvedValue({});
  });

  const entry = (overrides = {}) => {
    const save = jest.fn();
    return {
      agentName: 'walk-agent',
      displayName: 'Walk Agent',
      status: 'active',
      publisher: { userId: 'user1' },
      save,
      ...overrides,
    };
  };

  it('lets the publisher rename the entry, trimmed, and saves it', async () => {
    const e = entry();
    AgentRegistry.findOne.mockResolvedValue(e);

    const res = await request(app)
      .patch('/api/registry/agents/Walk-Agent/owned-entry')
      .send({ displayName: '  Scout Lite  ' })
      .expect(200);

    expect(AgentRegistry.findOne).toHaveBeenCalledWith({ agentName: 'walk-agent' });
    expect(res.body).toEqual({ agentName: 'walk-agent', displayName: 'Scout Lite', status: 'active' });
    expect(e.save).toHaveBeenCalledTimes(1);
  });

  it('retires the entry by setting it unpublished, and restores it to active', async () => {
    const e = entry();
    AgentRegistry.findOne.mockResolvedValue(e);

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: true }).expect(200);
    expect(e.status).toBe('unpublished');

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: false }).expect(200);
    expect(e.status).toBe('active');
  });

  it('lets a global admin change an entry they did not publish', async () => {
    AgentRegistry.findOne.mockResolvedValue(entry({ publisher: { userId: 'someone-else' } }));
    User.findById.mockReturnValue(actor('admin'));

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: true }).expect(200);
  });

  it('writes one AuditLog row per effective change, with the actor role', async () => {
    AgentRegistry.findOne.mockResolvedValue(entry());

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ displayName: 'Scout Lite' }).expect(200);
    expect(AuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'registry.entry.renamed',
      target: 'walk-agent',
      userId: 'user1',
      detail: expect.stringContaining('role=owner'),
    }));

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: true }).expect(200);
    expect(AuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'registry.entry.retired' }));

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: false }).expect(200);
    expect(AuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'registry.entry.restored' }));
    expect(AuditLog.create).toHaveBeenCalledTimes(3);
  });

  it('records a global admin change as role=admin', async () => {
    AgentRegistry.findOne.mockResolvedValue(entry({ publisher: { userId: 'someone-else' } }));
    User.findById.mockReturnValue(actor('admin'));

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: true }).expect(200);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.entry.retired',
      target: 'walk-agent',
      userId: 'user1',
      detail: expect.stringContaining('role=admin'),
    }));
  });

  it('writes no AuditLog row for a no-op write', async () => {
    AgentRegistry.findOne.mockResolvedValue(entry({ status: 'active' }));

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: false, displayName: 'Walk Agent' }).expect(200);
    expect(AuditLog.create).not.toHaveBeenCalled();
  });

  it('refuses a user who neither published the entry nor is an admin, and saves nothing', async () => {
    const e = entry({ publisher: { userId: 'someone-else' } });
    AgentRegistry.findOne.mockResolvedValue(e);

    const res = await request(app)
      .patch('/api/registry/agents/walk-agent/owned-entry')
      .send({ retired: true })
      .expect(403);

    expect(res.body.error).toBe('not_entry_owner');
    expect(e.save).not.toHaveBeenCalled();
    expect(e.status).toBe('active');
  });

  it('rejects a blank or over-long display name and a non-boolean retired flag', async () => {
    AgentRegistry.findOne.mockResolvedValue(entry());

    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ displayName: '  ' }).expect(400);
    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ displayName: 'x'.repeat(81) }).expect(400);
    await request(app).patch('/api/registry/agents/walk-agent/owned-entry').send({ retired: 'yes' }).expect(400);
  });

  it('returns 404 for an unknown entry', async () => {
    AgentRegistry.findOne.mockResolvedValue(null);

    await request(app).patch('/api/registry/agents/nope/owned-entry').send({ retired: true }).expect(404);
  });
});
