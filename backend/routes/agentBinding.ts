// ADR-026 D3: identity-level machine binding. Adoption is an atomic
// conditional transition (unbound → bound(machineId)) on the agent's bot
// User row — the loser of a concurrent adopt gets a clean 409, never a
// second runner. Rebinding is explicit release-then-adopt. The bound-agent
// predicate is enforced HERE from the daemon credential's server-side
// machineId — never from a caller-supplied value.
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
import daemonAuth, { DaemonAuthedRequest } from '../middleware/daemonAuth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

const router = express.Router();

const bindingRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { get?: (h: string) => string | undefined; ip?: string }) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 120 binding ops per 60s' });
  },
});

const normalize = (v: unknown): string => String(v ?? '').trim().toLowerCase();

// Ownership predicate — SOLE-INSTALLER (Vera's ruling on #1315). Two clauses,
// both must hold: an active installation of (agentName, instanceId)
// installedBy the owner exists, AND no active installation of that identity
// exists installedBy anyone else. The negative clause is what stops a shared
// identity (two humans each installed it) from being bound to one person's
// machine; once #609 gives per-owner identities it becomes redundant rather
// than wrong, so it stays.
type OwnershipFailure = 'owner_installation_missing' | 'another_installer' | 'unknown_installer';

type OwnershipCheck =
  | { owned: true }
  | { owned: false; failure: OwnershipFailure };

const ownershipFailureMessage: Record<OwnershipFailure, string> = {
  owner_installation_missing: 'No active installation for this daemon credential owner',
  another_installer: 'Another user has an active installation of this agent identity',
  unknown_installer: 'An active legacy installation has no recorded installer',
};

const ownsAgent = async (
  ownerUserId: unknown,
  agentName: string,
  instanceId: string,
): Promise<OwnershipCheck> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AgentInstallation } = require('../models/AgentRegistry');
  const mine = await AgentInstallation.findOne({
    agentName, instanceId, installedBy: ownerUserId, status: 'active',
  }).select('_id').lean();
  if (!mine) return { owned: false, failure: 'owner_installation_missing' };
  const others = await AgentInstallation.findOne({
    agentName, instanceId, status: 'active', installedBy: { $ne: ownerUserId },
  }).select('installedBy').lean();
  if (!others) return { owned: true };
  // MongoDB $ne also matches a missing field. Keep that legacy state safely
  // non-adoptable, but report it separately so an owner can repair it.
  if (!others.installedBy) return { owned: false, failure: 'unknown_installer' };
  return { owned: false, failure: 'another_installer' };
};

router.post('/adopt', bindingRateLimit, daemonAuth('agents:adopt'), async (req: DaemonAuthedRequest, res: express.Response) => {
  try {
    const agentName = normalize(req.body?.agentName);
    const instanceId = normalize(req.body?.instanceId) || 'default';
    if (!agentName) return res.status(400).json({ message: 'agentName required' });
    const machine = req.machine!;
    if (!machine.machineId) return res.status(400).json({ message: 'Daemon credential carries no machineId' });
    const ownership = await ownsAgent(machine.ownerUserId, agentName, instanceId);
    if (!ownership.owned) {
      return res.status(403).json({
        message: ownershipFailureMessage[ownership.failure],
        code: ownership.failure,
      });
    }
    // The CAS: only an UNBOUND identity transitions. matchedCount 0 with an
    // existing identity means someone else holds the binding → 409.
    const result = await User.updateOne(
      {
        isBot: true,
        'botMetadata.agentName': agentName,
        'botMetadata.instanceId': instanceId,
        $or: [{ 'botMetadata.machineId': null }, { 'botMetadata.machineId': { $exists: false } }],
      },
      { $set: { 'botMetadata.machineId': machine.machineId } },
    );
    if (result.modifiedCount === 1) {
      return res.json({ adopted: true, agentName, instanceId, machineId: machine.machineId });
    }
    const identity = await User.findOne({
      isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId,
    }).select('botMetadata.machineId').lean();
    if (!identity) return res.status(404).json({ message: 'Agent identity not found' });
    if (identity.botMetadata?.machineId === machine.machineId) {
      return res.json({ adopted: true, alreadyBound: true, agentName, instanceId, machineId: machine.machineId });
    }
    return res.status(409).json({
      message: 'Agent is bound to another machine — release it first',
      boundTo: identity.botMetadata?.machineId || null,
    });
  } catch (err) {
    console.error('adopt error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Release: the OWNER (human JWT) releases explicitly — rebinding is a
// deliberate two-step, never a daemon-side race (D3).
router.post('/release', bindingRateLimit, auth, async (req: express.Request & { user?: { id?: string } }, res: express.Response) => {
  try {
    const agentName = normalize(req.body?.agentName);
    const instanceId = normalize(req.body?.instanceId) || 'default';
    if (!agentName) return res.status(400).json({ message: 'agentName required' });
    const ownership = await ownsAgent(req.user?.id, agentName, instanceId);
    if (!ownership.owned) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const caller = await User.findById(req.user?.id).select('role').lean();
      if (caller?.role !== 'admin') {
        return res.status(403).json({
          message: ownershipFailureMessage[ownership.failure],
          code: ownership.failure,
        });
      }
    }
    const result = await User.updateOne(
      { isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId },
      { $set: { 'botMetadata.machineId': null } },
    );
    if (!result.matchedCount) return res.status(404).json({ message: 'Agent identity not found' });
    return res.json({ released: true, agentName, instanceId });
  } catch (err) {
    console.error('release error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
export {};
