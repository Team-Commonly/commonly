import type { IInstallableInstallation } from '../../models/InstallableInstallation';
import { INSTALL_LOCK_TTL_MS, userFacingInstallationError } from './installableInstallationService';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const ConnectorSecret = require('../../models/ConnectorSecret');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorSecrets = require('../connectorSecrets');
// The kinds registry is the single definition of where each kind's ref lives and
// what its unavailability is called. Both sweeps below read it — the orphan
// sweep's keep-condition was a literal `botTokenRef` pair, which revoked a
// Discord webhook secret ten minutes after it was written (vera 74130), and the
// unavailable sweep named Slack for any provider (vera 74131).
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { allRefPaths, kindSpec, rowReferencesSecret } = require('../connectorSecretKinds');
// The user-facing half of the error state: this module marks a row it cannot
// decrypt, and the reason is written for the person reading the Connectors page
// — the same flag the delivery-failure flip sets, so it comes from that service
// rather than a second `$set` here.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const connectorDeliveryFailures = require('../connectorDeliveryFailureService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const isPodMember = require('../../utils/isPodMember');

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
      // The copy is the outcome the operator reads in the Connectors list, so
      // it names the event and the next step and no internal one: a lock is our
      // word, not theirs (wren 73914, vera 73915).
      { $set: userFacingInstallationError('Setup was interrupted before it finished. Try again.') },
    );
    errored += result.modifiedCount || 0;
  }
  return { completed, errored };
};

const sweepActiveInstallations = async (): Promise<{ staleComponents: number; clearedPauseProjections: number }> => {
  const active = await InstallableInstallation.find({ status: 'active' }).lean() as IInstallableInstallation[];
  let staleComponents = 0;
  let clearedPauseProjections = 0;
  for (const installation of active) {
    // Resume clears children before it flips the parent active. If the second
    // write crashes, active is never reached; this branch only clears stale
    // projection flags left by an otherwise completed resume.
    const cleared = await Integration.updateMany(
      {
        installationId: installationIdFor(installation),
        'config.adminPause': { $exists: true },
      },
      { $unset: { 'config.adminPause': 1 } },
    );
    clearedPauseProjections += cleared.modifiedCount || 0;
    const integration = await Integration.findOne({ installationId: installationIdFor(installation) }).lean();
    if (integration) continue;
    const result = await InstallableInstallation.updateOne(
      { _id: installation._id, status: 'active' },
      {
        $set: {
          // Distinct from the page's generic 'Setup didn't finish.' on purpose: the
          // connector existed and its channel record vanished, which is a different
          // event, and the evidence pair has to read as two outcomes (vera 73915).
          ...userFacingInstallationError("This connector's channel is gone. Retry to rebuild it."),
          'components.$[].status': 'stale',
        },
      },
    );
    staleComponents += result.modifiedCount || 0;
  }
  return { staleComponents, clearedPauseProjections };
};

const pauseProjection = (installation: IInstallableInstallation) => ({
  reason: installation.adminPause?.reason || installation.errorMessage || 'Paused by an administrator.',
  at: installation.adminPause?.at || installation.updatedAt,
  adminId: installation.adminPause?.adminId || 'system',
});

// Pause writes the parent first and the child second. Re-apply the parent
// projection until each child agrees, so a failed child write heals toward the
// stopped state instead of accidentally restoring an inbound relay.
const sweepPausedInstallations = async (): Promise<number> => {
  const paused = await InstallableInstallation.find({ status: 'paused' }).lean() as IInstallableInstallation[];
  let restamped = 0;
  for (const installation of paused) {
    const pause = pauseProjection(installation);
    const result = await Integration.updateMany(
      {
        installationId: installationIdFor(installation),
        $or: [
          { 'config.adminPause': { $exists: false } },
          { 'config.adminPause.reason': { $ne: pause.reason } },
          { 'config.adminPause.at': { $ne: pause.at } },
          { 'config.adminPause.adminId': { $ne: pause.adminId } },
        ],
      },
      { $set: { 'config.adminPause': pause } },
    );
    restamped += result.modifiedCount || 0;
  }
  return restamped;
};

// Membership is authoritative on outbound selection, but prune obsolete keys
// here as well so the owner's gate list does not promise a pod they left.
const sweepOrphanedGates = async (): Promise<number> => {
  const rows = await Integration.find({
    scope: 'user',
    'config.gates': { $exists: true },
  }).select('_id createdBy podId config.gates').lean() as Array<{
    _id: unknown;
    createdBy?: unknown;
    podId?: unknown;
    config?: { gates?: Record<string, unknown> };
  }>;
  let pruned = 0;
  for (const row of rows) {
    const gates = row.config?.gates;
    if (!gates || typeof gates !== 'object') continue;
    const unset: Record<string, 1> = {};
    for (const podId of Object.keys(gates)) {
      const pod = await Pod.findById(podId).select('createdBy members').lean();
      if (!pod || !isPodMember(pod, row.createdBy)) {
        unset[`config.gates.${podId}`] = 1;
        if (String(row.podId) === podId) unset.podId = 1;
      }
    }
    if (!Object.keys(unset).length) continue;
    const result = await Integration.updateOne({ _id: row._id }, { $unset: unset });
    pruned += result.modifiedCount || 0;
  }
  return pruned;
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
  }).select('_id integrationId kind createdAt').lean() as Array<{
    _id: unknown;
    integrationId: unknown;
    kind?: string;
    createdAt: Date;
  }>;
  // Every path any kind can store a ref at, selected once: the keep-condition is
  // data drawn from the kinds registry, not a field name written here.
  const select = ['isActive', ...allRefPaths()].join(' ');
  let revoked = 0;
  for (const secret of secrets) {
    const spec = kindSpec(String(secret.kind ?? ''));
    if (!spec) {
      // An unrecognized kind is KEPT, not revoked. Nothing here knows where its
      // ref lives, and "the sweep cannot find a reference" is not evidence that
      // none exists — deleting on that reasoning is exactly how a Discord secret
      // was being deleted while its row still pointed at it.
      console.warn(
        `[installable-reconciler] connector secret ${String(secret._id)} has unrecognized kind `
        + `'${String(secret.kind)}'; kept`,
      );
      continue;
    }
    const integration = await Integration.findById(secret.integrationId)
      .select(select).lean() as Record<string, unknown> | null;
    const ref = String(secret._id);
    if (integration?.isActive === true && rowReferencesSecret(integration, spec, ref)) continue;
    await connectorSecrets.revoke(ref);
    revoked += 1;
  }
  return revoked;
};

const sweepUnavailableConnectorSecretKeys = async (): Promise<number> => {
  const secretCount = await ConnectorSecret.countDocuments();
  if (!secretCount) return 0;
  let unavailable: Array<{ integrationId: unknown; kind?: string }>;
  try {
    unavailable = await connectorSecrets.listWithUnavailableKey();
  } catch (error) {
    // A malformed or wholly absent ring makes every stored secret unreadable.
    // That is an error state, not an invitation to keep attempting sends.
    console.error('[installable-reconciler] connector secret key ring unavailable:', (error as Error).message);
    unavailable = await ConnectorSecret.find({}).select('integrationId kind').lean();
  }
  for (const secret of unavailable) {
    const integration = await Integration.findById(secret.integrationId)
      .select('installationId').lean() as { _id: unknown; installationId?: string } | null;
    if (integration) {
      // The reason names THIS secret's kind, so a Discord owner is not told that
      // a Slack secret is unavailable (the string is user-facing: it is written
      // through `userFacingError` and rendered on the Connectors page).
      const spec = kindSpec(String(secret.kind ?? ''));
      await connectorDeliveryFailures.markConnectorUnavailable(
        integration,
        spec ? spec.unavailableReason : 'Connector credential is unavailable',
      );
    }
  }
  return unavailable.length;
};

export const sweep = async (now: Date = new Date()): Promise<{
  completed: number;
  errored: number;
  staleComponents: number;
  clearedPauseProjections: number;
  restampedPauses: number;
  prunedGates: number;
  uninstallsCompleted: number;
  deactivated: number;
  expiredSlackBinds: number;
  orphanedSecrets: number;
  unavailableConnectorSecretKeys: number;
}> => {
  const locks = await sweepStaleLocks(now);
  const active = await sweepActiveInstallations();
  const restampedPauses = await sweepPausedInstallations();
  const prunedGates = await sweepOrphanedGates();
  const uninstallsCompleted = await sweepStaleUninstalls(now);
  const deactivated = await sweepUninstalledInstallations();
  const expiredSlackBinds = await sweepExpiredSlackBinds(now);
  const orphanedSecrets = await sweepOrphanedConnectorSecrets(now);
  const unavailableConnectorSecretKeys = await sweepUnavailableConnectorSecretKeys();
  const result = {
    ...locks,
    staleComponents: active.staleComponents,
    clearedPauseProjections: active.clearedPauseProjections,
    restampedPauses,
    prunedGates,
    uninstallsCompleted,
    deactivated,
    expiredSlackBinds,
    orphanedSecrets,
    unavailableConnectorSecretKeys,
  };
  console.log('[installable-reconciler] sweep', result);
  return result;
};

module.exports = { sweep };
