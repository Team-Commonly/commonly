export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adminAuth = require('../../middleware/adminAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../../models/Pod');

const router = express.Router();

// Personal / DM pod types that must NEVER be published to the public
// showcase, regardless of admin intent. A 1:1 DM is private by definition.
const PERSONAL_POD_TYPES = new Set(['agent-dm', 'agent-room', 'agent-admin']);

// POST /api/admin/pods/:podId/showcase  { publicRead: boolean }
// Admin-only toggle for the anonymous showcase read path. Rejects personal
// pod types so a private DM can never be flipped public.
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

      return res.json({ id: pod._id.toString(), publicRead: pod.publicRead });
    } catch (err) {
      console.error('[admin/pods] showcase toggle error:', (err as Error).message);
      return res.status(500).json({ error: 'Server Error' });
    }
  },
);

module.exports = router;
