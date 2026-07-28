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

      if (PERSONAL_POD_TYPES.has(String(pod.type))) {
        return res.status(400).json({
          error: `Cannot publish a personal pod type (${pod.type}) to the public showcase`,
        });
      }

      pod.publicRead = publicRead;

      // Preserve the listing invariant (#772): listed ⇒ readable. Unpublishing
      // a listed pod must also unlist it, otherwise this route re-creates the
      // exact { publicRead: false, communityListed: true } state the listing
      // endpoint below refuses to produce.
      const cascadeUnlisted = !publicRead && pod.communityListed === true;
      if (cascadeUnlisted) {
        pod.communityListed = false;
      }

      await pod.save();

      // Audit the world-readable state change (security review F6): who/when/
      // which pod/new value. Best-effort — never fail the toggle on audit error.
      try {
        await AuditLog.create({
          action: publicRead ? 'showcase.publish' : 'showcase.unpublish',
          target: pod._id.toString(),
          detail: `publicRead=${publicRead} type=${pod.type}`
            + (cascadeUnlisted ? ' communityListed=false (cascade)' : ''),
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
        communityListed: pod.communityListed === true,
      });
    } catch (err) {
      console.error('[admin/pods] showcase toggle error:', (err as Error).message);
      return res.status(500).json({ error: 'Server Error' });
    }
  },
);

// POST /api/admin/pods/:podId/listing  { communityListed: boolean }
//
// The missing writer (#772). `communityListed` gates both discovery scopes and
// the direct-join path, but until now nothing could set it over HTTP — only
// scripts/seed-community-pods.ts or a hand-written Mongo write. That made
// `joinPolicy: 'open'` a dormant bit and blocked every community-growth path
// at the data layer.
//
// Admin-only, matching the curation model already recorded on the schema
// (models/Pod.ts): "Listing is admin-curated for now; an owner-side 'request
// listing' flow is the planned phase 2 (Sam 2026-07-22)." ADR-016 may rename
// the field and add the owner-side path; neither changes the need for a writer.
//
// ⚠️ Listing a pod puts it on the Community discovery surface AND makes it
// directly self-joinable by any authenticated user (unless invite-only). It is
// strictly more exposure than `publicRead` alone, which is why it requires
// publicRead first.
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

      if (PERSONAL_POD_TYPES.has(String(pod.type))) {
        return res.status(400).json({
          error: `Cannot list a personal pod type (${pod.type}) on the community surface`,
        });
      }

      // The invariant: listed ⇒ readable. Refuse to create the
      // joinable-but-invisible state rather than silently flipping publicRead
      // on the admin's behalf — publishing a room world-readable is a
      // deliberate, separately-audited act (see the showcase toggle above).
      // Unlisting is always allowed.
      if (communityListed && pod.publicRead !== true) {
        return res.status(409).json({
          error: 'Pod must be publicRead before it can be listed to Community. '
            + 'Publish it via POST /api/admin/pods/:podId/showcase first.',
          code: 'listing_requires_public_read',
        });
      }

      pod.communityListed = communityListed;
      await pod.save();

      try {
        await AuditLog.create({
          action: communityListed ? 'community.list' : 'community.unlist',
          target: pod._id.toString(),
          detail: `communityListed=${communityListed} type=${pod.type} joinPolicy=${pod.joinPolicy}`,
          userId: req.userId || req.user?.id,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
        });
      } catch (auditErr) {
        console.warn('[admin/pods] audit log write failed (non-fatal):', (auditErr as Error).message);
      }

      return res.json({
        id: pod._id.toString(),
        publicRead: pod.publicRead === true,
        communityListed: pod.communityListed,
      });
    } catch (err) {
      console.error('[admin/pods] listing toggle error:', (err as Error).message);
      return res.status(500).json({ error: 'Server Error' });
    }
  },
);

module.exports = router;
