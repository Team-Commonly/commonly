const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (!req.header('Authorization')) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: '64b64c48c4f37a6b2f34c111' };
  return next();
});

jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
}));

jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/installable/installableInstallationService', () => ({
  install: jest.fn(),
  uninstall: jest.fn(),
  InstallLockLostError: class InstallLockLostError extends Error {},
  InstallableNotFoundError: class InstallableNotFoundError extends Error {},
  InstallableProjectionError: class InstallableProjectionError extends Error {},
  InstallInProgressError: class InstallInProgressError extends Error {},
}));

const Pod = require('../../../models/Pod');
const installationService = require('../../../services/installable/installableInstallationService');
const installableRoutes = require('../../../routes/installables');

const app = express();
app.use(express.json());
app.use('/api/installables', installableRoutes);

const auth = { Authorization: 'Bearer test-token' };
const podId = '64b64c48c4f37a6b2f34c222';

describe('installable connector routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a non-member before any install row is claimed', async () => {
    Pod.findById.mockResolvedValue({
      _id: podId,
      createdBy: { toString: () => 'someone-else' },
      members: ['someone-else'],
    });

    const res = await request(app)
      .post('/api/installables/telegram/install')
      .set(auth)
      .send({ podId });

    expect(res.status).toBe(403);
    expect(installationService.install).not.toHaveBeenCalled();
  });

  it('rejects an invalid podId without querying a pod or claiming an install', async () => {
    const response = await request(app)
      .post('/api/installables/telegram/install')
      .set('Authorization', 'Bearer valid')
      .send({ podId: 'not-an-object-id' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('podId must be a valid ObjectId');
    expect(Pod.findById).not.toHaveBeenCalled();
    expect(installationService.install).not.toHaveBeenCalled();
  });

  it('derives the install target from auth and accepts only the selected pod', async () => {
    Pod.findById.mockResolvedValue({
      _id: podId,
      createdBy: { toString: () => 'someone-else' },
      members: ['64b64c48c4f37a6b2f34c111'],
    });
    installationService.install.mockResolvedValue({
      httpStatus: 200,
      state: 'active',
      installation: { _id: 'install-1' },
      integration: { _id: 'integration-1' },
    });

    const res = await request(app)
      .post('/api/installables/telegram/install')
      .set(auth)
      .send({ podId });

    expect(res.status).toBe(200);
    expect(installationService.install).toHaveBeenCalledWith({
      installableId: 'telegram',
      installedBy: '64b64c48c4f37a6b2f34c111',
      podId,
    });
  });

  it('cannot use an uninstall body to target another user installation', async () => {
    installationService.uninstall.mockResolvedValue({ _id: 'install-1', status: 'uninstalled' });

    const res = await request(app)
      .delete('/api/installables/telegram/install')
      .set(auth)
      .send({ installationId: 'another-users-install' });

    expect(res.status).toBe(200);
    expect(installationService.uninstall).toHaveBeenCalledWith({
      installableId: 'telegram',
      installedBy: '64b64c48c4f37a6b2f34c111',
    });
  });

  it('does not report a concurrent revocation as disconnected', async () => {
    installationService.uninstall.mockResolvedValue({ _id: 'install-1', status: 'uninstalling' });

    const res = await request(app)
      .delete('/api/installables/telegram/install')
      .set(auth);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('uninstalling');
  });
});
