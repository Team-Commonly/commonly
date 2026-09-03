import { randomUUID } from 'crypto';
import { Types } from 'mongoose';

import type { IComponent, IInstallable } from '../../models/Installable';
import type {
  IComponentInstallation,
  IInstallableInstallation,
  InstallationStatus,
} from '../../models/InstallableInstallation';
import { mintConnectCode } from '../telegramConnectCode';
import { getProjector } from './projectors';
import type { ProjectionIds } from './projectors/types';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');

export const INSTALL_LOCK_TTL_MS = 60_000;

export class InstallLockLostError extends Error {
  code = 'install_lock_lost';

  constructor() {
    super('This install attempt was superseded by a newer attempt.');
    this.name = 'InstallLockLostError';
  }
}

export class InstallableProjectionError extends Error {
  code = 'install_projection_failed';

  constructor(message: string) {
    super(message);
    this.name = 'InstallableProjectionError';
  }
}

export class InstallableNotFoundError extends Error {
  code = 'installable_not_found';

  constructor() {
    super('Installable not found');
    this.name = 'InstallableNotFoundError';
  }
}

export interface InstallResult {
  installation: IInstallableInstallation;
  integration: unknown | null;
  httpStatus: 200 | 202;
  state: 'active' | 'installing' | 'activating';
}

interface ClaimResult {
  installation: IInstallableInstallation;
  ownsClaim: boolean;
  claimedState: 'installing' | 'activating' | 'active';
}

interface InstallArgs {
  installableId: string;
  installedBy: string;
  podId: string;
}

const installationKeys = (installableId: string, targetId: Types.ObjectId) => ({
  installableId,
  targetType: 'user',
  targetId,
});

const asObjectId = (value: string, field: string): Types.ObjectId => {
  if (!Types.ObjectId.isValid(value)) throw new Error(`${field} must be a valid ObjectId`);
  return new Types.ObjectId(value);
};

const statusForClaim = (status: InstallationStatus | undefined): 'installing' | 'activating' => (
  status === 'activating' ? 'activating' : 'installing'
);

const isStale = (claimedAt: Date | undefined, now: Date): boolean => (
  !claimedAt || claimedAt.getTime() <= now.getTime() - INSTALL_LOCK_TTL_MS
);

const hasClaim = (installation: IInstallableInstallation, claimId: string): boolean => (
  installation.claimId === claimId
);

const projectionIdsToObject = (ids: ProjectionIds): Map<string, Types.ObjectId> => {
  const entries = Object.entries(ids).map(([key, value]) => [
    key,
    value instanceof Types.ObjectId ? value : new Types.ObjectId(String(value)),
  ] as [string, Types.ObjectId]);
  return new Map(entries);
};

const componentRecord = (
  component: IComponent,
  projectionIds: ProjectionIds,
): IComponentInstallation => ({
  componentName: component.name,
  componentType: component.type,
  instanceId: 'default',
  status: 'active',
  config: new Map([
    ['eventType', component.eventType || ''],
    ['eventHandler', component.eventHandler || ''],
  ]),
  projectionIds: projectionIdsToObject(projectionIds),
  usage: { totalCalls: 0 },
  createdAt: new Date(),
  updatedAt: new Date(),
});

const integrationFor = async (installation: IInstallableInstallation): Promise<unknown | null> => (
  Integration.findOne({ installationId: String(installation._id) })
);

const resultForExisting = async (
  installation: IInstallableInstallation,
): Promise<InstallResult> => {
  const integration = await integrationFor(installation);
  if (installation.status === 'active') {
    return { installation, integration, httpStatus: 200, state: 'active' };
  }
  return {
    installation,
    integration,
    httpStatus: 202,
    state: installation.status === 'activating' ? 'activating' : 'installing',
  };
};

const claimInstallation = async (
  installable: IInstallable,
  targetId: Types.ObjectId,
  installedBy: Types.ObjectId,
): Promise<ClaimResult> => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - INSTALL_LOCK_TTL_MS);
  const claimId = randomUUID();
  const keys = installationKeys(installable.installableId, targetId);

  // This is the installation lock. An existing active/fresh transient row is
  // deliberately excluded from the filter; its unique partial index turns an
  // attempted upsert into a duplicate-key loser path below, which then returns
  // the winner without ever running a projector.
  try {
    const installation = await InstallableInstallation.findOneAndUpdate(
      {
        ...keys,
        $or: [
          { status: 'error' },
          { status: { $in: ['installing', 'activating'] }, claimedAt: { $lte: staleBefore } },
          { status: { $exists: false } },
        ],
      },
      [
        {
          $set: {
            installableVersion: installable.version,
            scope: installable.scope,
            installedBy,
            installSource: 'direct',
            grantedScopes: installable.requires || [],
            status: {
              $cond: [
                { $eq: ['$status', 'activating'] },
                'activating',
                'installing',
              ],
            },
            claimId,
            claimedAt: now,
            errorMessage: null,
            components: { $ifNull: ['$components', []] },
          },
        },
      ],
      { new: true, upsert: true },
    ) as IInstallableInstallation;

    return {
      installation,
      ownsClaim: hasClaim(installation, claimId),
      claimedState: statusForClaim(installation.status),
    };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;

    const winner = await InstallableInstallation.findOne(keys) as IInstallableInstallation | null;
    if (!winner) throw error;
    if (winner.status === 'error' || isStale(winner.claimedAt, now)) {
      // A concurrent state transition beat our filter. Retrying the atomic
      // claim is safe; only a returned matching generation owns work.
      return claimInstallation(installable, targetId, installedBy);
    }
    return {
      installation: winner,
      ownsClaim: false,
      claimedState: winner.status === 'active' ? 'active' : statusForClaim(winner.status),
    };
  }
};

const throwIfLockLost = (installation: IInstallableInstallation | null): IInstallableInstallation => {
  if (!installation) throw new InstallLockLostError();
  return installation;
};

const markProjectionFailure = async (
  installation: IInstallableInstallation,
  claimId: string,
  components: IComponentInstallation[],
  error: Error,
): Promise<void> => {
  const failed = await InstallableInstallation.findOneAndUpdate(
    { _id: installation._id, status: 'installing', claimId },
    {
      $set: {
        status: 'error',
        errorMessage: error.message,
        components,
      },
    },
    { new: true },
  ) as IInstallableInstallation | null;
  throwIfLockLost(failed);
};

const projectComponents = async (
  installation: IInstallableInstallation,
  installable: IInstallable,
  installedBy: Types.ObjectId,
  podId: Types.ObjectId,
  claimId: string,
): Promise<IInstallableInstallation> => {
  const components: IComponentInstallation[] = [];
  try {
    for (const component of installable.components) {
      const projector = getProjector(component.type);
      if (!projector) throw new Error(`Unsupported component type: ${component.type}`);
      const projectionIds = await projector.project(component, {
        installation,
        installable,
        installedBy,
        podId,
        claimId,
      });
      components.push(componentRecord(component, projectionIds));
    }
  } catch (error) {
    await markProjectionFailure(installation, claimId, components, error as Error);
    throw new InstallableProjectionError((error as Error).message);
  }

  const projected = await InstallableInstallation.findOneAndUpdate(
    { _id: installation._id, status: 'installing', claimId },
    { $set: { components } },
    { new: true },
  ) as IInstallableInstallation | null;
  return throwIfLockLost(projected);
};

const transitionToActivating = async (
  installation: IInstallableInstallation,
  claimId: string,
): Promise<IInstallableInstallation> => {
  if (installation.status === 'activating') return installation;
  const activating = await InstallableInstallation.findOneAndUpdate(
    { _id: installation._id, status: 'installing', claimId },
    { $set: { status: 'activating', claimedAt: new Date() } },
    { new: true },
  ) as IInstallableInstallation | null;
  return throwIfLockLost(activating);
};

const renewActivationLease = async (
  installation: IInstallableInstallation,
  claimId: string,
): Promise<IInstallableInstallation> => {
  // This is the last parent CAS before the cross-collection activation write.
  // If a stalled owner was taken over, it observes a null result here and does
  // absolutely nothing to the winner's projection. If it wins this renewal,
  // no valid takeover can claim the parent for the following lease window.
  const renewed = await InstallableInstallation.findOneAndUpdate(
    { _id: installation._id, status: 'activating', claimId },
    { $set: { claimedAt: new Date() } },
    { new: true },
  ) as IInstallableInstallation | null;
  return throwIfLockLost(renewed);
};

const activateIntegration = async (
  installation: IInstallableInstallation,
  claimId: string,
): Promise<unknown> => {
  const minted = mintConnectCode();
  const activated = await Integration.findOneAndUpdate(
    {
      installationId: String(installation._id),
      isActive: false,
    },
    {
      $set: {
        isActive: true,
        installationClaimId: claimId,
        'config.connectCode': minted.connectCode,
        'config.connectCodeExpiresAt': minted.connectCodeExpiresAt,
      },
    },
    { new: true },
  );
  if (activated) return activated;

  // A retry after a crash between writes 2 and 3 sees the already-minted
  // code. It must complete the parent only; minting again invalidates the
  // code the user may already have copied.
  const existing = await integrationFor(installation) as {
    isActive?: boolean;
    config?: { connectCode?: string };
  } | null;
  if (existing?.isActive && existing.config?.connectCode) return existing;
  throw new Error('Integration activation did not find an inactive projection');
};

const finishActivation = async (
  installation: IInstallableInstallation,
  claimId: string,
): Promise<IInstallableInstallation> => {
  const completed = await InstallableInstallation.findOneAndUpdate(
    { _id: installation._id, status: 'activating', claimId },
    { $set: { status: 'active', errorMessage: null } },
    { new: true },
  ) as IInstallableInstallation | null;
  return throwIfLockLost(completed);
};

export const install = async ({
  installableId,
  installedBy,
  podId,
}: InstallArgs): Promise<InstallResult> => {
  const normalizedId = String(installableId || '').toLowerCase();
  const installable = await Installable.findOne({
    installableId: normalizedId,
    status: 'active',
    kind: 'app',
  }) as IInstallable | null;
  if (!installable) throw new InstallableNotFoundError();

  const installerId = asObjectId(installedBy, 'installer');
  const targetPodId = asObjectId(podId, 'podId');
  const claim = await claimInstallation(installable, installerId, installerId);
  if (!claim.ownsClaim) return resultForExisting(claim.installation);

  let installation = claim.installation;
  const claimId = installation.claimId;
  if (!claimId) throw new InstallLockLostError();

  if (claim.claimedState === 'installing') {
    installation = await projectComponents(
      installation,
      installable,
      installerId,
      targetPodId,
      claimId,
    );
    installation = await transitionToActivating(installation, claimId);
  }

  installation = await renewActivationLease(installation, claimId);
  const integration = await activateIntegration(installation, claimId);
  installation = await finishActivation(installation, claimId);
  return { installation, integration, httpStatus: 200, state: 'active' };
};

export const uninstall = async ({
  installableId,
  installedBy,
}: Pick<InstallArgs, 'installableId' | 'installedBy'>): Promise<IInstallableInstallation> => {
  const targetId = asObjectId(installedBy, 'installer');
  const normalizedId = String(installableId || '').toLowerCase();
  const installation = await InstallableInstallation.findOne(
    { ...installationKeys(normalizedId, targetId), status: { $ne: 'uninstalled' } },
  ) as IInstallableInstallation | null;
  if (!installation) throw new InstallableNotFoundError();

  const uninstalled = await InstallableInstallation.findOneAndUpdate(
    { _id: installation._id, status: { $ne: 'uninstalled' } },
    { $set: { status: 'uninstalled', errorMessage: null } },
    { new: true },
  ) as IInstallableInstallation | null;
  if (!uninstalled) return installation;

  const installable = await Installable.findOne({ installableId: normalizedId }) as IInstallable | null;
  if (installable) {
    for (const component of installable.components) {
      const projector = getProjector(component.type);
      if (!projector) continue;
      const installedComponent = installation.components.find(
        (entry) => entry.componentName === component.name,
      );
      const ids = installedComponent?.projectionIds
        ? Object.fromEntries(installedComponent.projectionIds.entries()) as ProjectionIds
        : {};
      await projector.unproject(component, {
        installation,
        installable,
        installedBy: targetId,
        claimId: installation.claimId || '',
      }, ids);
    }
  } else {
    // The parent is the authority. A retired manifest must not make a user
    // unable to deactivate its projected channel row.
    await Integration.findOneAndUpdate(
      { installationId: String(installation._id) },
      {
        $set: { isActive: false },
        $unset: {
          'config.connectCode': 1,
          'config.connectCodeExpiresAt': 1,
          installationClaimId: 1,
        },
      },
    );
  }

  return uninstalled;
};

module.exports = {
  INSTALL_LOCK_TTL_MS,
  InstallLockLostError,
  InstallableProjectionError,
  InstallableNotFoundError,
  install,
  uninstall,
};
