// @ts-nocheck

const mongoose = require('mongoose');

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const ConnectorSecret = require('../../../models/ConnectorSecret');
const {
  install,
  uninstall,
  InstallLockLostError,
  InstallableAlreadyInstalledError,
  InstallableProjectionError,
} = require('../../../services/installable/installableInstallationService');
const { sweep } = require('../../../services/installable/installableReconciler');
const { TELEGRAM_CONNECTOR, SLACK_CONNECTOR } = require('../../../scripts/seed-builtin-connectors');
const { put } = require('../../../services/connectorSecrets');
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
  const originalKeys = process.env.CONNECTOR_SECRET_KEYS;
  const originalActiveKey = process.env.CONNECTOR_SECRET_ACTIVE_KEY;

  beforeAll(async () => {
    await setupMongoDb();
    await InstallableInstallation.syncIndexes();
    await ConnectorSecret.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
    process.env.CONNECTOR_SECRET_KEYS = originalKeys;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = originalActiveKey;
  });

  beforeEach(async () => {
    await clearMongoDb();
    await Installable.create({
      ...TELEGRAM_CONNECTOR,
      stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
    });
    await Installable.create({
      ...SLACK_CONNECTOR,
      stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
    });
    process.env.CONNECTOR_SECRET_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k1';
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
    expect(String(result.installation.boundPodId)).toBe(podId);
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
    const webhookProjector = projectorRegistry.get('webhook');
    const project = jest.spyOn(webhookProjector, 'project');
    const [first, second] = await Promise.all([
      install({ installableId: 'telegram', installedBy: userId, podId }),
      install({ installableId: 'telegram', installedBy: userId, podId }),
    ]);

    expect([first.httpStatus, second.httpStatus]).toEqual(expect.arrayContaining([200]));
    expect(await InstallableInstallation.countDocuments({ installableId: 'telegram' })).toBe(1);
    expect(await Integration.countDocuments({ type: 'telegram' })).toBe(1);
    expect(project).toHaveBeenCalledTimes(1);
    project.mockRestore();

    const retry = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(retry.httpStatus).toBe(200);
    expect(String(retry.installation._id)).toBe(String(first.installation._id));
  });

  it('refuses a different pod instead of reporting an existing install as a success', async () => {
    const { userId, podId } = ids();
    const otherPodId = new mongoose.Types.ObjectId().toString();
    await install({ installableId: 'telegram', installedBy: userId, podId });
    const before = await InstallableInstallation.findOne({ installableId: 'telegram' });

    await expect(install({ installableId: 'telegram', installedBy: userId, podId: otherPodId }))
      .rejects.toMatchObject({
        code: 'already_installed',
        boundPodId: podId,
      });
    await expect(install({ installableId: 'telegram', installedBy: userId, podId: otherPodId }))
      .rejects.toBeInstanceOf(InstallableAlreadyInstalledError);

    const integration = await Integration.findOne({ type: 'telegram' });
    expect(String(integration.podId)).toBe(podId);
    const after = await InstallableInstallation.findById(before._id);
    expect(after).toMatchObject({
      status: 'active',
      claimId: before.claimId,
      claimedAt: before.claimedAt,
    });
  });

  it('uses an existing active projection as the binding authority after parent completion recovers', async () => {
    const { userId, podId } = ids();
    const retryPodId = new mongoose.Types.ObjectId().toString();
    const first = await install({ installableId: 'telegram', installedBy: userId, podId });

    // A retry can update claim intent before boot reconciliation observes the
    // already-active projection and finishes the parent. The projection, not
    // that newer intent, decides where the live relay routes.
    await InstallableInstallation.updateOne(
      { _id: first.installation._id },
      { $set: { boundPodId: new mongoose.Types.ObjectId(retryPodId), status: 'active' } },
    );

    await expect(install({ installableId: 'telegram', installedBy: userId, podId: retryPodId }))
      .rejects.toMatchObject({
        code: 'already_installed',
        boundPodId: podId,
      });
    const integration = await Integration.findById(first.integration._id);
    expect(String(integration.podId)).toBe(podId);
  });

  it('reports a fresh claim in progress without re-targeting it', async () => {
    const { userId, podId } = ids();
    const otherPodId = new mongoose.Types.ObjectId().toString();
    const targetId = new mongoose.Types.ObjectId(userId);
    const parent = await InstallableInstallation.create({
      installableId: 'telegram',
      installableVersion: '1.0.0',
      targetType: 'user',
      targetId,
      scope: 'user',
      boundPodId: new mongoose.Types.ObjectId(podId),
      installedBy: targetId,
      installSource: 'direct',
      status: 'installing',
      claimId: 'owner-a',
      claimedAt: new Date(),
    });

    const waiting = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(waiting).toMatchObject({ httpStatus: 202, state: 'installing', boundPodId: podId });

    await expect(install({ installableId: 'telegram', installedBy: userId, podId: otherPodId }))
      .rejects.toMatchObject({ code: 'install_in_progress', boundPodId: podId });

    const after = await InstallableInstallation.findById(parent._id);
    expect(after).toMatchObject({
      status: 'installing',
      claimId: 'owner-a',
      claimedAt: parent.claimedAt,
      boundPodId: new mongoose.Types.ObjectId(podId),
    });
    expect(await Integration.countDocuments({ installationId: String(parent._id) })).toBe(0);
  });

  it('survives repeated component failures and claims the same projection on retry', async () => {
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

    await expect(install({ installableId: 'telegram', installedBy: userId, podId }))
      .rejects.toBeInstanceOf(InstallableProjectionError);
    const failedTwice = await InstallableInstallation.findById(failed._id);
    expect(failedTwice.status).toBe('error');
    expect(await Integration.countDocuments({ installationId: String(failed._id) })).toBe(1);

    await Installable.updateOne(
      { installableId: 'telegram' },
      { $set: { 'components.1.eventHandler': 'internal:telegram.relay' } },
    );
    const retryPodId = new mongoose.Types.ObjectId().toString();
    const retried = await install({ installableId: 'telegram', installedBy: userId, podId: retryPodId });
    expect(String(retried.installation._id)).toBe(String(failed._id));
    expect(retried.integration.config.connectCode).toMatch(/^[a-f0-9]{32}$/);
    expect(String(retried.integration.podId)).toBe(retryPodId);
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

  it('returns 202 for a fresh activating split, then takes it over and mints once after the lease', async () => {
    const { userId, podId } = ids();
    const targetId = new mongoose.Types.ObjectId(userId);
    const parent = await InstallableInstallation.create({
      installableId: 'telegram',
      installableVersion: '1.0.0',
      targetType: 'user',
      targetId,
      scope: 'user',
      installedBy: targetId,
      installSource: 'direct',
      status: 'activating',
      claimId: 'owner-a',
      claimedAt: new Date(),
    });
    await Integration.create({
      installationId: String(parent._id),
      installationClaimId: 'owner-a',
      podId,
      type: 'telegram',
      status: 'pending',
      createdBy: targetId,
      isActive: false,
      config: { liveRelay: true, linkedUserId: userId },
    });

    const waiting = await install({ installableId: 'telegram', installedBy: userId, podId });
    expect(waiting.httpStatus).toBe(202);
    expect(waiting.state).toBe('activating');

    parent.claimedAt = new Date(Date.now() - 61_000);
    await parent.save();
    const retryPodId = new mongoose.Types.ObjectId().toString();
    const recovered = await install({ installableId: 'telegram', installedBy: userId, podId: retryPodId });
    expect(recovered.httpStatus).toBe(200);
    expect(recovered.integration.config.connectCode).toMatch(/^[a-f0-9]{32}$/);
    expect(String(recovered.integration.podId)).toBe(retryPodId);
    expect(await Integration.countDocuments({ installationId: String(parent._id) })).toBe(1);
  });

  it('returns a typed lock loss when an activating parent has no projection', async () => {
    const { userId, podId } = ids();
    const targetId = new mongoose.Types.ObjectId(userId);
    await InstallableInstallation.create({
      installableId: 'telegram',
      installableVersion: '1.0.0',
      targetType: 'user',
      targetId,
      scope: 'user',
      installedBy: targetId,
      installSource: 'direct',
      status: 'activating',
      claimId: 'missing-projection-owner',
      claimedAt: new Date(Date.now() - 61_000),
    });

    await expect(install({ installableId: 'telegram', installedBy: userId, podId }))
      .rejects.toBeInstanceOf(InstallLockLostError);
    expect(await Integration.countDocuments({ type: 'telegram' })).toBe(0);
  });

  it('refuses a revived stale owner without changing the winner code or unprojecting', async () => {
    const { userId, podId } = ids();
    const originalFindOneAndUpdate = Integration.findOneAndUpdate.bind(Integration);
    let releaseOwner;
    let reachedOwnerActivation;
    const ownerActivationReached = new Promise((resolve) => { reachedOwnerActivation = resolve; });
    const ownerMayContinue = new Promise((resolve) => { releaseOwner = resolve; });
    let firstActivation = true;
    const findOneAndUpdate = jest.spyOn(Integration, 'findOneAndUpdate').mockImplementation(async (filter, ...args) => {
      if (firstActivation && filter?.isActive === false && filter?.revokedAt?.$exists === false) {
        firstActivation = false;
        reachedOwnerActivation();
        await ownerMayContinue;
      }
      return originalFindOneAndUpdate(filter, ...args);
    });
    const webhookProjector = projectorRegistry.get('webhook');
    const unproject = jest.spyOn(webhookProjector, 'unproject');

    try {
      const ownerA = install({ installableId: 'telegram', installedBy: userId, podId });
      await ownerActivationReached;
      const parent = await InstallableInstallation.findOne({ installableId: 'telegram' });
      parent.claimedAt = new Date(Date.now() - 61_000);
      await parent.save();

      const ownerB = await install({ installableId: 'telegram', installedBy: userId, podId });
      const winnerCode = ownerB.integration.config.connectCode;
      releaseOwner(null);

      await expect(ownerA).rejects.toBeInstanceOf(InstallLockLostError);
      const finalParent = await InstallableInstallation.findById(parent._id);
      const finalIntegration = await Integration.findOne({ installationId: String(parent._id) });
      expect(finalParent.status).toBe('active');
      expect(finalIntegration.config.connectCode).toBe(winnerCode);
      expect(await Integration.countDocuments({ installationId: String(parent._id) })).toBe(1);
      expect(unproject).not.toHaveBeenCalled();
    } finally {
      findOneAndUpdate.mockRestore();
      unproject.mockRestore();
    }
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
    const duplicateAfterHistoricalUninstall = await install({
      installableId: 'telegram', installedBy: userId, podId,
    });
    expect(duplicateAfterHistoricalUninstall.httpStatus).toBe(200);
    expect(String(duplicateAfterHistoricalUninstall.installation._id)).toBe(
      String(replacement.installation._id),
    );

    await uninstall({ installableId: 'telegram', installedBy: userId });
    const replacementAfterSecondUninstall = await Integration.findById(replacement.integration._id);
    expect(replacementAfterSecondUninstall.isActive).toBe(false);
  });

  it('revokes Slack’s envelope secret when the installation is uninstalled', async () => {
    const { userId, podId } = ids();
    const installed = await install({ installableId: 'slack', installedBy: userId, podId });
    const ref = await put(String(installed.integration._id), 'slack', 'xoxb-secret');
    await Integration.updateOne(
      { _id: installed.integration._id },
      { $set: { 'config.botTokenRef': ref } },
    );

    await uninstall({ installableId: 'slack', installedBy: userId });

    expect(await ConnectorSecret.findById(ref)).toBeNull();
    expect((await Integration.findById(installed.integration._id)).config.botTokenRef).toBeUndefined();
  });

  it('finishes a stale revocation before re-installing a new parent and projection', async () => {
    const { userId, podId } = ids();
    const first = await install({ installableId: 'telegram', installedBy: userId, podId });
    const oldIntegration = await Integration.findById(first.integration._id);
    const oldCode = oldIntegration.config.connectCode;
    const stale = await InstallableInstallation.findById(first.installation._id);
    stale.status = 'uninstalling';
    stale.claimId = 'dead-uninstall-owner';
    stale.claimedAt = new Date(Date.now() - 61_000);
    await stale.save();

    const replacement = await install({ installableId: 'telegram', installedBy: userId, podId });
    const retired = await InstallableInstallation.findById(first.installation._id);
    const deactivated = await Integration.findById(first.integration._id);

    expect(replacement.httpStatus).toBe(200);
    expect(String(replacement.installation._id)).not.toBe(String(first.installation._id));
    expect(String(replacement.integration._id)).not.toBe(String(first.integration._id));
    expect(retired.status).toBe('uninstalled');
    expect(deactivated.isActive).toBe(false);
    expect(deactivated.config.connectCode).toBeUndefined();
    expect(deactivated.revokedAt).toBeInstanceOf(Date);
    expect(replacement.integration.isActive).toBe(true);
    expect(replacement.integration.config.connectCode).toMatch(/^[a-f0-9]{32}$/);
    expect(replacement.integration.config.connectCode).not.toBe(oldCode);
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
    expect(integration.installationClaimId).toBe(installed.installation.claimId);
    expect(integration.revokedAt).toBeInstanceOf(Date);
  });

  it('sweeps stale installing and inactive activating rows to error', async () => {
    const { userId, podId } = ids();
    const targetId = new mongoose.Types.ObjectId(userId);
    const installing = await InstallableInstallation.create({
      installableId: 'telegram', installableVersion: '1.0.0', targetType: 'user', targetId,
      scope: 'user', installedBy: targetId, installSource: 'direct', status: 'installing',
      claimId: 'installing-a', claimedAt: new Date(Date.now() - 61_000),
    });
    const activating = await InstallableInstallation.create({
      installableId: 'telegram-inactive', installableVersion: '1.0.0', targetType: 'user',
      targetId: new mongoose.Types.ObjectId(), scope: 'user', installedBy: targetId,
      installSource: 'direct', status: 'activating', claimId: 'activating-a',
      claimedAt: new Date(Date.now() - 61_000),
    });
    await Integration.create({
      installationId: String(activating._id), installationClaimId: 'activating-a', podId,
      type: 'telegram', status: 'pending', createdBy: targetId, isActive: false,
      config: { liveRelay: true, linkedUserId: userId },
    });

    const reconciled = await sweep(new Date());
    expect(reconciled.errored).toBe(2);
    expect((await InstallableInstallation.findById(installing._id)).status).toBe('error');
    expect((await InstallableInstallation.findById(activating._id)).status).toBe('error');
  });

  it('marks a live parent stale when its projected Integration has been deleted', async () => {
    const { userId, podId } = ids();
    const installed = await install({ installableId: 'telegram', installedBy: userId, podId });
    await Integration.deleteOne({ _id: installed.integration._id });

    const reconciled = await sweep(new Date());
    const parent = await InstallableInstallation.findById(installed.installation._id);
    expect(reconciled.staleComponents).toBe(1);
    expect(parent.components.every((component) => component.status === 'stale')).toBe(true);
  });

  it('expires a pending Slack bind, revokes its encrypted token, and leaves a retryable active card', async () => {
    const { userId, podId } = ids();
    const installed = await install({ installableId: 'slack', installedBy: userId, podId });
    const ref = await put(String(installed.integration._id), 'slack', 'xoxb-secret');
    await Integration.updateOne(
      { _id: installed.integration._id },
      {
        $set: {
          'config.pendingBind': {
            teamId: 'T1', slackUserId: 'U1', chatId: 'D1', botTokenRef: ref,
            expiresAt: new Date(Date.now() - 1),
          },
        },
      },
    );

    const reconciled = await sweep(new Date());
    const integration = await Integration.findById(installed.integration._id);
    const parent = await InstallableInstallation.findById(installed.installation._id);

    expect(reconciled.expiredSlackBinds).toBe(1);
    expect(integration.isActive).toBe(true);
    expect(integration.status).toBe('pending');
    expect(integration.config.pendingBind?.botTokenRef).toBeUndefined();
    expect(await ConnectorSecret.findById(ref)).toBeNull();
    expect(parent.components.every((component) => component.status === 'active')).toBe(true);
  });

  it('does not sweep a freshly written orphaned secret before a callback can commit its bind', async () => {
    const ref = await put(new mongoose.Types.ObjectId().toString(), 'slack', 'xoxb-secret');
    const now = new Date();

    const fresh = await sweep(now);
    expect(fresh.orphanedSecrets).toBe(0);
    expect(await ConnectorSecret.findById(ref)).not.toBeNull();

    await ConnectorSecret.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(ref) },
      { $set: { createdAt: new Date(now.getTime() - (10 * 60_000) - 1) } },
    );
    const expired = await sweep(now);
    expect(expired.orphanedSecrets).toBe(1);
    expect(await ConnectorSecret.findById(ref)).toBeNull();
  });

  it('keeps a Slack projection visible but error-gated when its secret key disappears from the ring', async () => {
    const { userId, podId } = ids();
    const installed = await install({ installableId: 'slack', installedBy: userId, podId });
    const ref = await put(String(installed.integration._id), 'slack', 'xoxb-secret');
    await Integration.updateOne(
      { _id: installed.integration._id },
      {
        $set: {
          'config.botTokenRef': ref,
          'config.teamId': 'T1',
          'config.chatId': 'D1',
          'config.chatType': 'im',
        },
      },
    );
    process.env.CONNECTOR_SECRET_KEYS = `k2:${Buffer.alloc(32, 2).toString('base64')}`;
    process.env.CONNECTOR_SECRET_ACTIVE_KEY = 'k2';

    const reconciled = await sweep(new Date());
    const integration = await Integration.findById(installed.integration._id);
    const parent = await InstallableInstallation.findById(installed.installation._id);

    expect(reconciled.unavailableSlackSecretKeys).toBe(1);
    expect(integration.isActive).toBe(true);
    expect(integration.status).toBe('error');
    expect(integration.errorMessage).toMatch(/secret key/i);
    expect(parent.components.every((component) => component.status === 'active')).toBe(true);
  });

  it('completes a stale activating row with its already-active, same-generation projection', async () => {
    const { userId, podId } = ids();
    const result = await install({ installableId: 'telegram', installedBy: userId, podId });
    const installation = await InstallableInstallation.findById(result.installation._id);
    const integration = await Integration.findById(result.integration._id);
    const originalCode = integration.config.connectCode;

    installation.status = 'activating';
    installation.claimId = 'takeover-b';
    installation.claimedAt = new Date(Date.now() - 61_000);
    await installation.save();
    integration.installationClaimId = 'owner-a';
    await integration.save();

    const reconciled = await sweep(new Date());
    const completed = await InstallableInstallation.findById(installation._id);
    const unchanged = await Integration.findById(integration._id);
    expect(reconciled.completed).toBe(1);
    expect(completed.status).toBe('active');
    expect(unchanged.config.connectCode).toBe(originalCode);
  });
});
