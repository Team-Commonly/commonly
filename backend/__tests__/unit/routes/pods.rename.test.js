const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AuditLog = require('../../../models/AuditLog');

jest.mock('../../../models/Pod');
jest.mock('../../../models/User');
jest.mock('../../../models/AuditLog');

const routes = require('../../../routes/pods');

const actorWithRole = (role) => ({
  select: () => ({ lean: async () => ({ role }) }),
});

describe('PATCH /api/pods/:id/name (TASK-419)', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/pods', routes);
    jest.clearAllMocks();
    AuditLog.create = jest.fn().mockResolvedValue({});
    User.findById.mockReturnValue(actorWithRole('user'));
  });

  const pod = (overrides = {}) => {
    const save = jest.fn();
    return {
      _id: { toString: () => 'p1' },
      name: 'Old name',
      type: 'chat',
      createdBy: { toString: () => 'user1' },
      save,
      ...overrides,
    };
  };

  it('lets the pod creator rename the pod, trimmed, and saves it', async () => {
    const p = pod();
    Pod.findById.mockResolvedValue(p);

    const res = await request(app)
      .patch('/api/pods/p1/name')
      .send({ name: '  Launch room  ' })
      .expect(200);

    expect(res.body).toEqual({ id: 'p1', name: 'Launch room' });
    expect(p.name).toBe('Launch room');
    expect(p.save).toHaveBeenCalledTimes(1);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'pod.renamed', target: 'p1' }));
  });

  it('lets a global admin rename a pod they did not create', async () => {
    Pod.findById.mockResolvedValue(pod({ createdBy: { toString: () => 'someone-else' } }));
    User.findById.mockReturnValue(actorWithRole('admin'));

    await request(app).patch('/api/pods/p1/name').send({ name: 'Renamed by admin' }).expect(200);
  });

  it('refuses a member who is neither the creator nor an admin, and does not save', async () => {
    const p = pod({ createdBy: { toString: () => 'someone-else' } });
    Pod.findById.mockResolvedValue(p);

    const res = await request(app).patch('/api/pods/p1/name').send({ name: 'Hijack' }).expect(403);

    expect(res.body.error).toBe('not_pod_owner');
    expect(p.save).not.toHaveBeenCalled();
    expect(p.name).toBe('Old name');
  });

  it('rejects a blank name and a name over 80 characters', async () => {
    Pod.findById.mockResolvedValue(pod());

    await request(app).patch('/api/pods/p1/name').send({ name: '   ' }).expect(400);
    await request(app).patch('/api/pods/p1/name').send({ name: 'x'.repeat(81) }).expect(400);
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown pod', async () => {
    Pod.findById.mockResolvedValue(null);

    await request(app).patch('/api/pods/missing/name').send({ name: 'Anything' }).expect(404);
  });

  it('does not rename an unlistable pod type', async () => {
    const p = pod({ type: 'agent-dm' });
    Pod.findById.mockResolvedValue(p);

    await request(app).patch('/api/pods/p1/name').send({ name: 'Nope' }).expect(400);
    expect(p.save).not.toHaveBeenCalled();
  });
});
