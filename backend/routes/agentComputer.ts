/** Owner-only human takeover bridge. Steel API, CDP and live view stay private. */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { agentComputerBroker, agentComputerEnabled } from '../services/agentComputerBroker';

const auth = require('../middleware/auth');
const { AgentInstallation } = require('../models/AgentRegistry');
const User = require('../models/User');
const router = express.Router();
const ID = /^[a-f\d]{24}$/i;

router.use(rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false }));
router.use(auth);
router.use('/:installationId', async (req: any, res: express.Response, next: express.NextFunction) => {
  if (!agentComputerEnabled()) return res.status(404).json({ code: 'computer_disabled', error: 'Agent computer is unavailable.' });
  const userId = String(req.userId || req.user?.id || req.user?._id || '');
  const installationId = String(req.params.installationId || '');
  if (!ID.test(userId) || !ID.test(installationId)) return res.status(400).json({ error: 'Invalid owner or installation.' });
  try {
    const [owner, installation] = await Promise.all([
      User.findById(userId).select('isBot').lean(),
      AgentInstallation.findOne({ _id: installationId, installedBy: userId, status: 'active' })
        .select('_id config').lean(),
    ]);
    if (!owner || owner.isBot !== false || !installation) {
      return res.status(403).json({ code: 'not_owner', error: 'Installation is not yours.' });
    }
    const config = installation.config instanceof Map ? Object.fromEntries(installation.config) : installation.config;
    const runtime = config?.runtime instanceof Map ? Object.fromEntries(config.runtime) : config?.runtime;
    if (runtime?.runtimeType !== 'native' || !Array.isArray(config?.tools)
      || !config.tools.includes('computer_request_takeover')) {
      return res.status(403).json({ code: 'computer_not_granted', error: 'This installation has no computer access.' });
    }
    res.locals.computerOwnerId = userId;
    return next();
  } catch { return res.status(503).json({ error: 'Computer ownership could not be checked.' }); }
});

const run = (action: (userId: string, installationId: string, req: express.Request) => Promise<unknown>) => (
  async (req: express.Request, res: express.Response) => {
    try {
      const result = await action(res.locals.computerOwnerId, req.params.installationId, req);
      if (Buffer.isBuffer(result)) {
        res.set('Cache-Control', 'no-store');
        res.type('png');
        return res.send(result);
      }
      return res.json(result ?? { ok: true });
    } catch (error) {
      const message = (error as Error).message;
      const code = message.startsWith('Stale computer frame') ? 'stale_frame'
        : message.startsWith('No human takeover') ? 'takeover_not_active' : 'computer_unavailable';
      return res.status(409).json({ code, error: message });
    }
  }
);

router.get('/:installationId/status', run((owner, installation) => agentComputerBroker.takeoverStatus(owner, installation)));
router.get('/:installationId/frame', run((owner, installation) => agentComputerBroker.humanScreenshot(owner, installation)));
router.post('/:installationId/click', run(async (owner, installation, req) => {
  await agentComputerBroker.humanClick(
    owner, installation, Number(req.body?.x), Number(req.body?.y), String(req.body?.frameRevision || ''),
  );
}));
router.post('/:installationId/type', run(async (owner, installation, req) => {
  if (typeof req.body?.text !== 'string') throw new Error('Text is required.');
  await agentComputerBroker.humanType(owner, installation, req.body.text, String(req.body?.frameRevision || ''));
}));
router.post('/:installationId/press', run(async (owner, installation, req) => {
  await agentComputerBroker.humanPress(
    owner, installation, String(req.body?.key || ''), String(req.body?.frameRevision || ''),
  );
}));
router.post('/:installationId/hand-back', run(async (owner, installation) => {
  await agentComputerBroker.handBack(owner, installation);
}));

module.exports = router;
