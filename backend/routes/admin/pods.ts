export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adminAuth = require('../../middleware/adminAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuditLog = require('../../models/AuditLog');

const router = express.Router();

// Personal / DM pod types that must NEVER be published to the public
// showcase, regardless of admin intent. A 1:1 DM is private by definition.
const PERSONAL_POD_TYPES = new Set(['agent-dm', 'agent-room', 'agent-admin']);

// POST /api/admin/pods/:podId/showcase  { publicRead: boolean }
// Admin-only toggle for the anonymous showcase read path. Rejects personal
// pod types so a private DM can never be flipped public.
//
// ⚠️ OPERATIONAL WARNING (security review F3): flipping publicRead=true makes
// this pod's conversation WORLD-READABLE — not a frozen snapshot, but every
// current AND future message anyone/any agent posts to it. The showcase
// noise-filter strips errors/cruft, NOT secrets — it is a quality filter, not
// a redactor. Only ever publish a deliberately curated demo pod with no
// secrets/PII and consenting members. Treat this toggle as "this room is now
// public forever, including everything said in it from now on."
router.post(
  '/:podId/showcase',
  auth,
  adminAuth,
  async (req: any, res: any) => {
    try {
      const { podId } = req.params;
      const { publicRead } = req.body || {};
      if (typeof publicRead !== 'boolean') {
        return res.status(400).json({ error: 'publicRead (boolean) is required' });
      }

      const pod = await Pod.findById(podId);
      if (!pod) {
        return res.status(404).json({ error: 'Pod not found' });
      }

      if (PERSONAL_POD_TYPES.has(String(pod.type))) {
        return res.status(400).json({
          error: `Cannot publish a personal pod type (${pod.type}) to the public showcase`,
        });
      }

      pod.publicRead = publicRead;
      await pod.save();

      // Audit the world-readable state change (security review F6): who/when/
      // which pod/new value. Best-effort — never fail the toggle on audit error.
      try {
        await AuditLog.create({
          action: publicRead ? 'showcase.publish' : 'showcase.unpublish',
          target: pod._id.toString(),
          detail: `publicRead=${publicRead} type=${pod.type}`,
          userId: req.userId || req.user?.id,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
        });
      } catch (auditErr) {
        console.warn('[admin/pods] audit log write failed (non-fatal):', (auditErr as Error).message);
      }

      return res.json({ id: pod._id.toString(), publicRead: pod.publicRead });
    } catch (err) {
      console.error('[admin/pods] showcase toggle error:', (err as Error).message);
      return res.status(500).json({ error: 'Server Error' });
    }
  },
);

module.exports = router;
