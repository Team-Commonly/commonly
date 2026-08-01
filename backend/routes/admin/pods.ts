export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rateLimit = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adminAuth = require('../../middleware/adminAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuditLog = require('../../models/AuditLog');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NON_LISTABLE_POD_TYPES } = require('../../services/podListing');

const router = express.Router();

// Inlined limiter so CodeQL's js/missing-rate-limiting recognises the guard on
// this DB-touching admin route; skipped under NODE_ENV=test. Admin-gated, so
// this is defense-in-depth, not the primary control.
const adminPodsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req: any, res: any) => res.status(429).json({ error: 'rate_limited' }),
});

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
  adminPodsRateLimit,
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

      if (NON_LISTABLE_POD_TYPES.includes(String(pod.type))) {
        return res.status(400).json({
          error: `Cannot publish a personal pod type (${pod.type}) to the public showcase`,
        });
      }

      const cascadedCommunityUnlist = publicRead === false && pod.communityListed === true;
      pod.publicRead = publicRead;
      if (cascadedCommunityUnlist) {
        pod.communityListed = false;
      }
      await pod.save();

      // Audit the world-readable state change (security review F6): who/when/
      // which pod/new value. Best-effort — never fail the toggle on audit error.
      try {
        await AuditLog.create({
          action: publicRead ? 'showcase.publish' : 'showcase.unpublish',
          target: pod._id.toString(),
          detail: [
            `publicRead=${publicRead}`,
            `type=${pod.type}`,
            cascadedCommunityUnlist ? 'communityListed=false cascade=unlisted' : null,
          ].filter(Boolean).join(' '),
          userId: req.userId || req.user?.id,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
        });
      } catch (auditErr) {
        console.warn('[admin/pods] audit log write failed (non-fatal):', (auditErr as Error).message);
      }

      return res.json({
        id: pod._id.toString(),
        publicRead: pod.publicRead,
        communityListed: pod.communityListed,
      });
    } catch (err) {
      console.error('[admin/pods] showcase toggle error:', (err as Error).message);
      return res.status(500).json({ error: 'Server Error' });
    }
  },
);

// POST /api/admin/pods/:podId/listing  { communityListed: boolean }
// Admin-only curation toggle for Community discovery. Listing refines public
// readability: publishing a pod remains a separate, explicitly audited action.
router.post(
  '/:podId/listing',
  adminPodsRateLimit,
  auth,
  adminAuth,
  async (req: any, res: any) => {
    try {
      const { podId } = req.params;
      const { communityListed } = req.body || {};
      if (typeof communityListed !== 'boolean') {
        return res.status(400).json({ error: 'communityListed (boolean) is required' });
      }

      const pod = await Pod.findById(podId);
      if (!pod) {
        return res.status(404).json({ error: 'Pod not found' });
      }

      if (NON_LISTABLE_POD_TYPES.includes(String(pod.type))) {
        return res.status(400).json({
          error: `Cannot list a personal pod type (${pod.type}) in Community`,
        });
      }

      if (communityListed && pod.publicRead !== true) {
        return res.status(409).json({
          error: 'listing_requires_public_read',
          message: `Publish the pod first with POST /api/admin/pods/${pod._id}/showcase`,
        });
      }

      pod.communityListed = communityListed;
      await pod.save();

      try {
        await AuditLog.create({
          action: communityListed ? 'community.list' : 'community.unlist',
          target: pod._id.toString(),
          detail: `communityListed=${communityListed} publicRead=${pod.publicRead} type=${pod.type}`,
          userId: req.userId || req.user?.id,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
        });
      } catch (auditErr) {
        console.warn('[admin/pods] audit log write failed (non-fatal):', (auditErr as Error).message);
      }

      return res.json({
        id: pod._id.toString(),
        publicRead: pod.publicRead,
        communityListed: pod.communityListed,
      });
    } catch (err) {
      console.error('[admin/pods] community listing toggle error:', (err as Error).message);
      return res.status(500).json({ error: 'Server Error' });
    }
  },
);

module.exports = router;
