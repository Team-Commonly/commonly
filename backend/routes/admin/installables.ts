// Administrator stop/resume lever for user-scoped connector installations.
// It intentionally does not expose owner configuration: an admin can stop a
// private relay and say why, but cannot author into or reconfigure its DM.

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const auth = require('../../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const adminAuth = require('../../middleware/adminAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
import { Types } from 'mongoose';

interface AuthReq {
  user?: { id?: string };
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}

const router: ReturnType<typeof express.Router> = express.Router();

const requiredReason = (body: unknown): string | null => {
  const reason = (body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== 'string' || !reason.trim()) return null;
  return reason.trim();
};

const installationFilter = (req: AuthReq, status: 'active' | 'paused') => {
  const installationId = String(req.params?.installationId || '');
  if (!Types.ObjectId.isValid(installationId)) return null;
  return {
    _id: installationId,
    installableId: String(req.params?.installableId || '').toLowerCase(),
    targetType: 'user',
    scope: 'user',
    status,
  };
};

const auditEntry = (action: 'pause' | 'resume', installation: {
  _id: unknown;
  installedBy?: unknown;
}, adminId: string, reason: string, at: Date) => ({
  action,
  installationId: String(installation._id),
  ownerId: String(installation.installedBy || ''),
  adminId,
  reason,
  at,
});

/**
 * Pause is parent-first: a crash after the first write has already stopped
 * outbound dispatch. The reconciler repairs a child which was not stamped.
 */
router.post('/:installableId/installations/:installationId/pause', auth, adminAuth, async (req: AuthReq, res: any) => {
  const reason = requiredReason(req.body);
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const filter = installationFilter(req, 'active');
  if (!filter) return res.status(400).json({ error: 'installationId must be a valid ObjectId' });
  const adminId = String(req.user?.id || '');
  const at = new Date();

  try {
    const existing = await InstallableInstallation.findOne(filter);
    if (!existing) return res.status(404).json({ error: 'Active installation not found' });
    const installation = await InstallableInstallation.findOneAndUpdate(
      filter,
      {
        $set: {
          status: 'paused',
          errorMessage: reason,
          adminPause: { reason, at, adminId },
        },
        $push: { pauseAudit: auditEntry('pause', existing, adminId, reason, at) },
      },
      { new: true },
    );
    if (!installation) return res.status(404).json({ error: 'Active installation not found' });

    try {
      await Integration.updateMany(
        { installationId: String(installation._id) },
        { $set: { 'config.adminPause': { reason, at, adminId } } },
      );
    } catch (error) {
      console.error('[admin/installables] pause projection failed:', (error as Error).message);
      return res.status(202).json({ status: 'paused', projected: false, installation });
    }
    return res.json({ status: 'paused', projected: true, installation });
  } catch (error) {
    console.error('[admin/installables] pause failed:', (error as Error).message);
    return res.status(500).json({ error: 'Could not pause installation' });
  }
});

/**
 * Resume is children-first. If parent completion fails, the parent remains
 * paused and the reconciler re-stamps children on its next pass.
 */
router.post('/:installableId/installations/:installationId/resume', auth, adminAuth, async (req: AuthReq, res: any) => {
  const reason = requiredReason(req.body);
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const filter = installationFilter(req, 'paused');
  if (!filter) return res.status(400).json({ error: 'installationId must be a valid ObjectId' });
  const adminId = String(req.user?.id || '');
  const at = new Date();

  try {
    const existing = await InstallableInstallation.findOne(filter);
    if (!existing) return res.status(404).json({ error: 'Paused installation not found' });
    try {
      await Integration.updateMany(
        { installationId: String(existing._id) },
        { $unset: { 'config.adminPause': 1 } },
      );
    } catch (error) {
      console.error('[admin/installables] resume projection failed:', (error as Error).message);
      return res.status(202).json({ status: 'paused', projected: false, installation: existing });
    }
    const installation = await InstallableInstallation.findOneAndUpdate(
      filter,
      {
        $set: { status: 'active', errorMessage: null },
        $unset: { adminPause: 1 },
        $push: { pauseAudit: auditEntry('resume', existing, adminId, reason, at) },
      },
      { new: true },
    );
    if (!installation) {
      return res.status(202).json({ status: 'paused', projected: false, installation: existing });
    }
    return res.json({ status: 'active', projected: true, installation });
  } catch (error) {
    console.error('[admin/installables] resume failed:', (error as Error).message);
    return res.status(500).json({ error: 'Could not resume installation' });
  }
});

module.exports = router;
