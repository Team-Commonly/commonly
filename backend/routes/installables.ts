// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const isPodMember = require('../utils/isPodMember');
import { Types } from 'mongoose';
import { writeIntegrationsRateLimit } from '../middleware/integrationRateLimit';
// eslint-disable-next-line global-require
const {
  InstallLockLostError,
  InstallableNotFoundError,
  InstallableProjectionError,
  install,
  uninstall,
} = require('../services/installable/installableInstallationService');

interface AuthReq {
  user?: { id?: string; _id?: string };
  userId?: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
}

interface Res {
  status: (status: number) => Res;
  json: (body: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const requesterId = (req: AuthReq): string | undefined => req.userId || req.user?.id || req.user?._id;

const sendInstallError = (error: Error, res: Res): void => {
  if (error instanceof InstallableNotFoundError) {
    res.status(404).json({ code: 'installable_not_found', error: error.message });
    return;
  }
  if (error instanceof InstallLockLostError) {
    res.status(409).json({ code: 'install_lock_lost', error: error.message });
    return;
  }
  if (error instanceof InstallableProjectionError) {
    res.status(422).json({ code: 'install_projection_failed', error: error.message });
    return;
  }
  if (/must be a valid ObjectId/.test(error.message)) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error('[installable] install failed:', error.message);
  res.status(500).json({ error: 'Could not install connector' });
};

/**
 * POST /api/installables/:installableId/install
 *
 * Phase 1 is intentionally narrow: the only client choice is the pod that
 * becomes this user-scoped connector's first gate. Target identity is always
 * taken from auth, never from a body field.
 */
router.post('/:installableId/install', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const body = req.body || {};
  if (Array.isArray(body) || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be an object with podId' });
  }
  if (Object.keys(body).some((key) => key !== 'podId')) {
    return res.status(400).json({ error: 'Only podId is accepted when installing a connector' });
  }
  const podId = body.podId;
  if (typeof podId !== 'string' || !podId) {
    return res.status(400).json({ error: 'podId is required' });
  }
  if (!Types.ObjectId.isValid(podId)) {
    return res.status(400).json({ error: 'podId must be a valid ObjectId' });
  }
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const pod = await Pod.findById(podId);
    if (!pod || !isPodMember(pod, userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const result = await install({
      installableId: String(req.params?.installableId || ''),
      installedBy: String(userId),
      podId,
    });
    return res.status(result.httpStatus).json({
      status: result.state,
      installation: result.installation,
      integration: result.integration,
    });
  } catch (error) {
    return sendInstallError(error as Error, res);
  }
});

/**
 * DELETE /api/installables/:installableId/install
 *
 * There is no installation id in the path or body. The user's target row is
 * the only row this endpoint can ever deactivate, even if they share its pod.
 */
router.delete('/:installableId/install', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const installation = await uninstall({
      installableId: String(req.params?.installableId || ''),
      installedBy: String(userId),
    });
    if (installation.status === 'uninstalling') {
      return res.status(202).json({ status: 'uninstalling', installation });
    }
    return res.json({ status: 'uninstalled', installation });
  } catch (error) {
    return sendInstallError(error as Error, res);
  }
});

module.exports = router;
