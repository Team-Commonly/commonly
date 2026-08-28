import express from 'express';
import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Types } from 'mongoose';
import {
  listMachinesForOwner,
  recordMachineHeartbeat,
  registerMachine,
  removeMachine,
} from '../services/machineService';
import { daemonAuth, DaemonAuthRequest } from '../middleware/daemonAuth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

const router = express.Router();

// Keep every machine lifecycle endpoint bounded. Importing rateLimit directly
// makes this route family visible to CodeQL's missing-rate-limit check.
const machineRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { get?: (header: string) => string | undefined; ip?: string }) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: express.Response) => {
    res.status(429).json({ message: 'rate limit exceeded: 60 machine requests per 60s' });
  },
});

type AuthReq = express.Request & { user?: { id?: string } };

router.post('/', machineRateLimit, auth, async (req: AuthReq, res: express.Response) => {
  try {
    const ownerUserId = req.user?.id;
    if (!ownerUserId) return res.status(401).json({ message: 'Unauthorized' });
    const { machine, token } = await registerMachine({ ownerUserId, name: req.body?.name });
    // The raw daemon credential is intentionally only ever returned here.
    return res.status(201).json({ machine, daemonToken: token });
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith('Machine name') || message.startsWith('Machine limit')) {
      return res.status(400).json({ message });
    }
    console.error('Error registering machine:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post(
  '/:id/heartbeat',
  machineRateLimit,
  daemonAuth('machine:heartbeat'),
  async (req: DaemonAuthRequest, res: express.Response) => {
    try {
      const { id } = req.params;
      if (!Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid machine id' });
      if (String(req.machine?._id) !== id) return res.status(403).json({ message: 'Access denied' });
      const machine = await recordMachineHeartbeat(req.machine!);
      return res.json({ machine });
    } catch (error) {
      console.error('Error recording machine heartbeat:', error);
      return res.status(500).json({ message: 'Server error' });
    }
  },
);

router.get('/', machineRateLimit, auth, async (req: AuthReq, res: express.Response) => {
  try {
    const ownerUserId = req.user?.id;
    if (!ownerUserId) return res.status(401).json({ message: 'Unauthorized' });
    return res.json(await listMachinesForOwner(ownerUserId));
  } catch (error) {
    console.error('Error listing machines:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', machineRateLimit, auth, async (req: AuthReq, res: express.Response) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) return res.status(400).json({ message: 'Invalid machine id' });
    const actorUserId = req.user?.id;
    if (!actorUserId) return res.status(401).json({ message: 'Unauthorized' });
    const caller = await User.findById(actorUserId).select('role').lean();
    const result = await removeMachine({
      machineDbId: id,
      actorUserId,
      isAdmin: caller?.role === 'admin',
    });
    if (result === 'not_found') return res.status(404).json({ message: 'Machine not found' });
    if (result === 'forbidden') return res.status(403).json({ message: 'Access denied' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error removing machine:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
export {};
