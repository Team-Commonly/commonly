import type { IInstallableInstallation } from '../../models/InstallableInstallation';
import { INSTALL_LOCK_TTL_MS } from './installableInstallationService';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');

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
        installationClaimId?: string;
        config?: { connectCode?: string };
      } | null;
      if (
        integration?.isActive
        && integration.config?.connectCode
        && integration.installationClaimId === claimId
      ) {
        const result = await InstallableInstallation.updateOne(
          { _id: installation._id, status: 'activating', claimId },
          { $set: { status: 'active', errorMessage: null } },
        );
        completed += result.modifiedCount || 0;
        continue;
      }
      // A code with an unexpected generation is not ours to delete or
      // overwrite. Its parent will be diagnosed by the next retry rather than
      // making a sweep act like a stale owner.
      if (integration?.isActive && integration.config?.connectCode) continue;
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
          installationClaimId: 1,
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
          installationClaimId: installation.claimId,
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

export const sweep = async (now: Date = new Date()): Promise<{
  completed: number;
  errored: number;
  staleComponents: number;
  uninstallsCompleted: number;
  deactivated: number;
}> => {
  const locks = await sweepStaleLocks(now);
  const staleComponents = await sweepActiveInstallations();
  const uninstallsCompleted = await sweepStaleUninstalls(now);
  const deactivated = await sweepUninstalledInstallations();
  const result = { ...locks, staleComponents, uninstallsCompleted, deactivated };
  console.log('[installable-reconciler] sweep', result);
  return result;
};

module.exports = { sweep };
