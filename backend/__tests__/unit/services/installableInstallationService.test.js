// @ts-nocheck

const mongoose = require('mongoose');

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const {
  install,
  uninstall,
  InstallableProjectionError,
} = require('../../../services/installable/installableInstallationService');
const { sweep } = require('../../../services/installable/installableReconciler');
const { TELEGRAM_CONNECTOR } = require('../../../scripts/seed-builtin-connectors');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');
const { projectorRegistry } = require('../../../services/installable/projectors');

const ids = () => ({
  userId: new mongoose.Types.ObjectId().toString(),
  podId: new mongoose.Types.ObjectId().toString(),
});

describe('installable connector projection', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await InstallableInstallation.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await Installable.create({
      ...TELEGRAM_CONNECTOR,
      stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
    });
  });

  it('projects Telegram once, mints last, and shares one Integration between components', async () => {
    const { userId, podId } = ids();

    const result = await install({ installableId: 'telegram', installedBy: userId, podId });

    expect(result.httpStatus).toBe(200);
    expect(result.installation.status).toBe('active');
    expect(result.installation.components).toHaveLength(2);
    expect(result.installation.components.every((component) => component.status === 'active')).toBe(true);

    const integration = await Integration.findOne({ installationId: String(result.installation._id) });
    expect(integration).toMatchObject({
      installationId: String(result.installation._id),
      type: 'telegram',
      isActive: true,
      podId: expect.objectContaining({ toString: expect.any(Function) }),
    });
    expect(String(integration.podId)).toBe(podId);
    expect(integration.createdBy.toString()).toBe(userId);
    expect(integration.config.linkedUserId).toBe(userId);
    expect(integration.config.liveRelay).toBe(true);
    expect(integration.config.relayAllAgentMessages).toBe(true);
    expect(integration.config.connectCode).toMatch(/^[a-f0-9]{32}$/);
    expect(integration.config.connectCodeExpiresAt).toBeInstanceOf(Date);

    const projectedIds = result.installation.components.map((component) => (
      String(component.projectionIds.get('integrationId'))
    ));
    expect(new Set(projectedIds)).toEqual(new Set([String(integration._id)]));
  });

  it('returns the existing active install and only one parent during concurrent installs', async () => {
    const { userId, podId } = ids();
    const [first, second] = await Promise.all([
      install({ installableId: 'telegram', installedBy: userId, podId }),
      install({ installableId: 'telegram', installedBy: userId, podId }),
    ]);

    expect([first.httpStatus, second.httpStatus]).toEqual(expect.arrayContaining([200]));
    expect(await InstallableInstallation.countDocuments({ installableId: 'telegram' })).toBe(1);
    expect(await Integration.countDocuments({ type: 'telegram' })).toBe(1);

    const retry = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(retry.httpStatus).toBe(200);
    expect(String(retry.installation._id)).toBe(String(first.installation._id));
  });

  it('retains an inactive projection on a component error and claims the same parent on retry', async () => {
    const { userId, podId } = ids();
    await Installable.updateOne(
      { installableId: 'telegram' },
      { $set: { 'components.1.eventHandler': 'internal:missing' } },
    );

    await expect(install({ installableId: 'telegram', installedBy: userId, podId }))
      .rejects.toBeInstanceOf(InstallableProjectionError);

    const failed = await InstallableInstallation.findOne({ installableId: 'telegram' });
    const inactive = await Integration.findOne({ installationId: String(failed._id) });
    expect(failed.status).toBe('error');
    expect(inactive.isActive).toBe(false);
    expect(inactive.config.connectCode).toBeUndefined();

    await Installable.updateOne(
      { installableId: 'telegram' },
      { $set: { 'components.1.eventHandler': 'internal:telegram.relay' } },
    );
    const retried = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(String(retried.installation._id)).toBe(String(failed._id));
    expect(retried.integration.config.connectCode).toMatch(/^[a-f0-9]{32}$/);
    expect(await Integration.countDocuments({ installationId: String(failed._id) })).toBe(1);
  });

  it('returns 202 for a fresh claim and takes over the same parent after its lease expires', async () => {
    const { userId, podId } = ids();
    const targetId = new mongoose.Types.ObjectId(userId);
    const fresh = await InstallableInstallation.create({
      installableId: 'telegram',
      installableVersion: '1.0.0',
      targetType: 'user',
      targetId,
      scope: 'user',
      installedBy: targetId,
      installSource: 'direct',
      status: 'installing',
      claimId: 'owner-a',
      claimedAt: new Date(),
    });

    const waiting = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(waiting.httpStatus).toBe(202);
    expect(String(waiting.installation._id)).toBe(String(fresh._id));

    fresh.claimedAt = new Date(Date.now() - 61_000);
    await fresh.save();
    const takenOver = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(takenOver.httpStatus).toBe(200);
    expect(String(takenOver.installation._id)).toBe(String(fresh._id));
    expect(takenOver.installation.claimId).not.toBe('owner-a');
    expect(takenOver.integration.config.connectCode).toMatch(/^[a-f0-9]{32}$/);
  });

  it('resumes a stale activating generation without re-projecting or re-minting its code', async () => {
    const { userId, podId } = ids();
    const first = await install({ installableId: 'telegram', installedBy: userId, podId });
    const installation = await InstallableInstallation.findById(first.installation._id);
    const integration = await Integration.findById(first.integration._id);
    const originalCode = integration.config.connectCode;

    installation.status = 'activating';
    installation.claimedAt = new Date(Date.now() - 61_000);
    await installation.save();

    const resumed = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(resumed.httpStatus).toBe(200);
    expect(String(resumed.installation._id)).toBe(String(first.installation._id));
    expect(resumed.integration.config.connectCode).toBe(originalCode);
    expect(await Integration.countDocuments({ installationId: String(first.installation._id) })).toBe(1);
  });

  it('uninstalls by identity, clears the code, and creates a new projection on re-install', async () => {
    const { userId, podId } = ids();
    const first = await install({ installableId: 'telegram', installedBy: userId, podId });
    const integration = await Integration.findById(first.integration._id);
    integration.config.relayMap = [{ tgMessageId: '7', agentUsername: 'kai' }];
    await integration.save();

    const removed = await uninstall({ installableId: 'telegram', installedBy: userId });
    const inactive = await Integration.findById(first.integration._id);
    expect(removed.status).toBe('uninstalled');
    expect(inactive.isActive).toBe(false);
    expect(inactive.config.connectCode).toBeUndefined();
    expect(inactive.config.relayMap).toHaveLength(1);
    expect(inactive.revokedAt).toBeInstanceOf(Date);

    const replacement = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(String(replacement.installation._id)).not.toBe(String(first.installation._id));
    expect(String(replacement.integration._id)).not.toBe(String(first.integration._id));

    await uninstall({ installableId: 'telegram', installedBy: userId });
    const replacementAfterSecondUninstall = await Integration.findById(replacement.integration._id);
    expect(replacementAfterSecondUninstall.isActive).toBe(false);
  });

  it('keeps a failed revocation recoverable until its projection is inactive', async () => {
    const { userId, podId } = ids();
    const installed = await install({ installableId: 'telegram', installedBy: userId, podId });
    const originalEventProjector = projectorRegistry.get('event-handler');
    projectorRegistry.set('event-handler', {
      ...originalEventProjector,
      unproject: jest.fn().mockRejectedValue(new Error('projection unavailable')),
    });

    try {
      await expect(uninstall({ installableId: 'telegram', installedBy: userId }))
        .rejects.toThrow('projection unavailable');
    } finally {
      projectorRegistry.set('event-handler', originalEventProjector);
    }

    const pending = await InstallableInstallation.findById(installed.installation._id);
    const inactive = await Integration.findById(installed.integration._id);
    expect(pending.status).toBe('uninstalling');
    expect(inactive.isActive).toBe(false);
    expect(inactive.config.connectCode).toBeUndefined();
    expect(inactive.revokedAt).toBeInstanceOf(Date);
    const staleActivation = await Integration.findOneAndUpdate(
      {
        _id: inactive._id,
        isActive: false,
        revokedAt: { $exists: false },
      },
      { $set: { isActive: true } },
      { new: true },
    );
    expect(staleActivation).toBeNull();

    pending.claimedAt = new Date(Date.now() - 61_000);
    await pending.save();
    const reconciled = await sweep(new Date());
    expect(reconciled.uninstallsCompleted).toBe(1);
    expect((await InstallableInstallation.findById(pending._id)).status).toBe('uninstalled');
  });

  it('sweeps a crashed revocation by deactivating before it finalizes the parent', async () => {
    const { userId, podId } = ids();
    const installed = await install({ installableId: 'telegram', installedBy: userId, podId });
    const parent = await InstallableInstallation.findById(installed.installation._id);
    parent.status = 'uninstalling';
    parent.claimId = 'revocation-generation';
    parent.claimedAt = new Date(Date.now() - 61_000);
    await parent.save();

    const reconciled = await sweep(new Date());
    const finished = await InstallableInstallation.findById(parent._id);
    const integration = await Integration.findById(installed.integration._id);
    expect(reconciled.uninstallsCompleted).toBe(1);
    expect(finished.status).toBe('uninstalled');
    expect(integration.isActive).toBe(false);
    expect(integration.config.connectCode).toBeUndefined();
    expect(integration.installationClaimId).toBe('revocation-generation');
    expect(integration.revokedAt).toBeInstanceOf(Date);
  });

  it('completes a stale activating row with its already-active, same-generation projection', async () => {
    const { userId, podId } = ids();
    const result = await install({ installableId: 'telegram', installedBy: userId, podId });
    const installation = await InstallableInstallation.findById(result.installation._id);
    const integration = await Integration.findById(result.integration._id);
    const originalCode = integration.config.connectCode;

    installation.status = 'activating';
    installation.claimedAt = new Date(Date.now() - 61_000);
    await installation.save();

    const reconciled = await sweep(new Date());
    const completed = await InstallableInstallation.findById(installation._id);
    const unchanged = await Integration.findById(integration._id);
    expect(reconciled.completed).toBe(1);
    expect(completed.status).toBe('active');
    expect(unchanged.config.connectCode).toBe(originalCode);
  });
});
