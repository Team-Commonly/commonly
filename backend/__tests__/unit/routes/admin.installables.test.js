const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: req.header('x-test-user') || 'admin-1' };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => {
  if (req.header('x-test-admin') !== 'true') return res.status(403).json({ error: 'Admin access required' });
  return next();
});
jest.mock('../../../models/InstallableInstallation', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../../../models/Integration', () => ({ updateMany: jest.fn() }));

const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const adminInstallableRoutes = require('../../../routes/admin/installables');

const app = express();
app.use(express.json());
app.use('/api/admin/installables', adminInstallableRoutes);

const installableId = 'telegram';
const installationId = '64b64c48c4f37a6b2f34c222';
const admin = { 'x-test-admin': 'true' };
const active = {
  _id: installationId,
  installableId,
  targetType: 'user',
  scope: 'user',
  status: 'active',
  installedBy: 'owner-1',
};

describe('admin installable pause/resume', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requires the admin middleware before it can stop a private connector', async () => {
    const res = await request(app)
      .post(`/api/admin/installables/${installableId}/installations/${installationId}/pause`)
      .send({ reason: 'Safety review' });

    expect(res.status).toBe(403);
    expect(InstallableInstallation.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('requires a reason before any parent or projection write', async () => {
    const res = await request(app)
      .post(`/api/admin/installables/${installableId}/installations/${installationId}/pause`)
      .set(admin)
      .send({});

    expect(res.status).toBe(400);
    expect(InstallableInstallation.findOne).not.toHaveBeenCalled();
    expect(InstallableInstallation.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Integration.updateMany).not.toHaveBeenCalled();
  });

  it('pauses the parent before stamping its inbound projection', async () => {
    const paused = { ...active, status: 'paused' };
    InstallableInstallation.findOne.mockResolvedValue(active);
    InstallableInstallation.findOneAndUpdate.mockResolvedValue(paused);
    Integration.updateMany.mockResolvedValue({ modifiedCount: 1 });

    const res = await request(app)
      .post(`/api/admin/installables/${installableId}/installations/${installationId}/pause`)
      .set(admin)
      .send({ reason: 'Safety review' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'paused', projected: true });
    expect(InstallableInstallation.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', targetType: 'user', scope: 'user' }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'paused', adminPause: expect.objectContaining({ reason: 'Safety review' }) }),
        $push: expect.objectContaining({ pauseAudit: expect.objectContaining({ action: 'pause', ownerId: 'owner-1' }) }),
      }),
      { new: true },
    );
    expect(Integration.updateMany).toHaveBeenCalledWith(
      { installationId },
      expect.objectContaining({ $set: expect.objectContaining({ 'config.adminPause': expect.objectContaining({ reason: 'Safety review' }) }) }),
    );
  });

  it('reports a partial pause when child projection fails after the parent stopped', async () => {
    InstallableInstallation.findOne.mockResolvedValue(active);
    InstallableInstallation.findOneAndUpdate.mockResolvedValue({ ...active, status: 'paused' });
    Integration.updateMany.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app)
      .post(`/api/admin/installables/${installableId}/installations/${installationId}/pause`)
      .set(admin)
      .send({ reason: 'Safety review' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'paused', projected: false });
    expect(InstallableInstallation.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('clears children before resuming and leaves the parent paused if its completion CAS loses', async () => {
    const paused = { ...active, status: 'paused' };
    InstallableInstallation.findOne.mockResolvedValue(paused);
    Integration.updateMany.mockResolvedValue({ modifiedCount: 1 });
    InstallableInstallation.findOneAndUpdate.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/admin/installables/${installableId}/installations/${installationId}/resume`)
      .set(admin)
      .send({ reason: 'Review complete' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'paused', projected: false });
    expect(Integration.updateMany).toHaveBeenCalledWith(
      { installationId },
      { $unset: { 'config.adminPause': 1 } },
    );
    expect(InstallableInstallation.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'active' }) }),
      { new: true },
    );
  });
});
