import type { IInstallableInstallation } from '../../models/InstallableInstallation';
import { INSTALL_LOCK_TTL_MS } from './installableInstallationService';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const ConnectorSecret = require('../../models/ConnectorSecret');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('../connectorSecrets');

const ORPHAN_SECRET_GRACE_MS = 10 * 60_000;

const installationIdFor = (installation: IInstallableInstallation): string => String(installation._id);

const sweepStaleLocks = async (now: Date): Promise<{ completed: number; errored: number }> => {
  const staleBefore = new Date(now.getTime() - INSTALL_LOCK_TTL_MS);
  const stale = await InstallableInstallation.find({
    status: { $in: ['installing', 'activating'] },
    claimedAt: { $lte: staleBefore },
  }).lean() as IInstallableInstallation[];
  let completed = 0;
  let errored = 0;

  for (const installation of stale) {
    const claimId = installation.claimId;
    if (!claimId) continue;
    if (installation.status === 'activating') {
      const integration = await Integration.findOne({
        installationId: installationIdFor(installation),
      }).lean() as {
        isActive?: boolean;
        config?: { connectCode?: string };
      } | null;
      if (
        integration?.isActive
        && integration.config?.connectCode
      ) {
        const result = await InstallableInstallation.updateOne(
          { _id: installation._id, status: 'activating', claimId },
          { $set: { status: 'active', errorMessage: null } },
        );
        completed += result.modifiedCount || 0;
        continue;
      }
    }

    const result = await InstallableInstallation.updateOne(
      { _id: installation._id, status: installation.status, claimId },
      { $set: { status: 'error', errorMessage: 'install lock expired' } },
    );
    errored += result.modifiedCount || 0;
  }
  return { completed, errored };
};

const sweepActiveInstallations = async (): Promise<number> => {
  const active = await InstallableInstallation.find({ status: 'active' }).lean() as IInstallableInstallation[];
  let staleComponents = 0;
  for (const installation of active) {
    const integration = await Integration.findOne({ installationId: installationIdFor(installation) }).lean();
    if (integration) continue;
    const result = await InstallableInstallation.updateOne(
      { _id: installation._id, status: 'active' },
      { $set: { 'components.$[].status': 'stale' } },
    );
    staleComponents += result.modifiedCount || 0;
  }
  return staleComponents;
};

const sweepUninstalledInstallations = async (): Promise<number> => {
  const rows = await InstallableInstallation.find({ status: 'uninstalled' }).lean() as IInstallableInstallation[];
  let deactivated = 0;
  for (const installation of rows) {
    const result = await Integration.updateOne(
      { installationId: installationIdFor(installation), isActive: true },
      {
        $set: { isActive: false },
        $unset: {
          'config.connectCode': 1,
          'config.connectCodeExpiresAt': 1,
        },
      },
    );
    deactivated += result.modifiedCount || 0;
  }
  return deactivated;
};

const sweepStaleUninstalls = async (now: Date): Promise<number> => {
  const staleBefore = new Date(now.getTime() - INSTALL_LOCK_TTL_MS);
  const rows = await InstallableInstallation.find({
    status: 'uninstalling',
    claimedAt: { $lte: staleBefore },
  }).lean() as IInstallableInstallation[];
  let completed = 0;

  for (const installation of rows) {
    if (!installation.claimId) continue;
    // This is the revocation equivalent of the activating split-commit
    // recovery. Parent state is only finalized after the projection is made
    // inactive; the claim fence makes a stale sweep harmless to a takeover.
    await Integration.updateOne(
      { installationId: installationIdFor(installation) },
      {
        $set: {
          isActive: false,
          revokedAt: new Date(),
        },
        $unset: {
          'config.connectCode': 1,
          'config.connectCodeExpiresAt': 1,
        },
      },
    );
    const result = await InstallableInstallation.updateOne(
      { _id: installation._id, status: 'uninstalling', claimId: installation.claimId },
      { $set: { status: 'uninstalled', errorMessage: null } },
    );
    completed += result.modifiedCount || 0;
  }
  return completed;
};

const markSlackIntegrationUnavailable = async (
  integration: { _id: unknown },
  message: string,
): Promise<void> => {
  await Integration.updateOne(
    { _id: integration._id, isActive: true },
    { $set: { status: 'error', errorMessage: message } },
  );
};

const sweepExpiredSlackBinds = async (now: Date): Promise<number> => {
  const rows = await Integration.find({
    type: 'slack',
    isActive: true,
    'config.pendingBind.expiresAt': { $lte: now },
  }).select('installationId config.pendingBind').lean() as Array<{
    _id: unknown;
    installationId?: string;
    config?: { pendingBind?: { botTokenRef?: string } };
  }>;
  let expired = 0;
  for (const integration of rows) {
    const ref = integration.config?.pendingBind?.botTokenRef;
    const claimed = await Integration.findOneAndUpdate(
      {
        _id: integration._id,
        isActive: true,
        'config.pendingBind.expiresAt': { $lte: now },
        'config.pendingBind.botTokenRef': ref,
      },
      {
        $set: { status: 'pending', errorMessage: null },
        $unset: { 'config.pendingBind': 1 },
      },
      { new: true },
    );
    if (!claimed) continue;
    await connectorSecrets.revoke(ref);
    expired += 1;
  }
  return expired;
};

const sweepOrphanedConnectorSecrets = async (now: Date): Promise<number> => {
  const secrets = await ConnectorSecret.find({
    createdAt: { $lte: new Date(now.getTime() - ORPHAN_SECRET_GRACE_MS) },
  }).select('_id integrationId createdAt').lean() as Array<{
    _id: unknown;
    integrationId: unknown;
    createdAt: Date;
  }>;
  let revoked = 0;
  for (const secret of secrets) {
    const integration = await Integration.findById(secret.integrationId)
      .select('isActive config.botTokenRef config.pendingBind.botTokenRef').lean() as {
        isActive?: boolean;
        config?: { botTokenRef?: string; pendingBind?: { botTokenRef?: string } };
      } | null;
    const ref = String(secret._id);
    if (
      integration?.isActive === true
      && (integration.config?.botTokenRef === ref || integration.config?.pendingBind?.botTokenRef === ref)
    ) continue;
    await connectorSecrets.revoke(ref);
    revoked += 1;
  }
  return revoked;
};

const sweepUnavailableSlackSecretKeys = async (): Promise<number> => {
  const secretCount = await ConnectorSecret.countDocuments();
  if (!secretCount) return 0;
  let unavailable: Array<{ integrationId: unknown }>;
  try {
    unavailable = await connectorSecrets.listWithUnavailableKey();
  } catch (error) {
    // A malformed or wholly absent ring makes every stored secret unreadable.
    // That is an error state, not an invitation to keep attempting sends.
    console.error('[installable-reconciler] connector secret key ring unavailable:', (error as Error).message);
    unavailable = await ConnectorSecret.find({}).select('integrationId').lean();
  }
  for (const secret of unavailable) {
    const integration = await Integration.findById(secret.integrationId)
      .select('installationId').lean() as { _id: unknown; installationId?: string } | null;
    if (integration) await markSlackIntegrationUnavailable(integration, 'Slack connector secret key is unavailable');
  }
  return unavailable.length;
};

export const sweep = async (now: Date = new Date()): Promise<{
  completed: number;
  errored: number;
  staleComponents: number;
  uninstallsCompleted: number;
  deactivated: number;
  expiredSlackBinds: number;
  orphanedSecrets: number;
  unavailableSlackSecretKeys: number;
}> => {
  const locks = await sweepStaleLocks(now);
  const staleComponents = await sweepActiveInstallations();
  const uninstallsCompleted = await sweepStaleUninstalls(now);
  const deactivated = await sweepUninstalledInstallations();
  const expiredSlackBinds = await sweepExpiredSlackBinds(now);
  const orphanedSecrets = await sweepOrphanedConnectorSecrets(now);
  const unavailableSlackSecretKeys = await sweepUnavailableSlackSecretKeys();
  const result = {
    ...locks,
    staleComponents,
    uninstallsCompleted,
    deactivated,
    expiredSlackBinds,
    orphanedSecrets,
    unavailableSlackSecretKeys,
  };
  console.log('[installable-reconciler] sweep', result);
  return result;
};

module.exports = { sweep };
