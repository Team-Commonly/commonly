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
      // A successful adopt consumes any pending placement request — the
      // binding IS the fulfilled request, whichever machine it named.
      { $set: { 'botMetadata.machineId': machine.machineId, 'botMetadata.requestedMachineId': null } },
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

// ADR-026 Phase 2: placement request — the OWNER (human JWT, i.e. the UI's
// "run it on <machine>" choice) asks for an agent to run on one of their
// machines. This writes a DIRECTIVE, never a binding: the daemon on that
// machine sees the request in /assigned and performs the adopt CAS itself,
// so D3's "no adoption without a user choice" and "one binding writer" both
// hold. machineId: null withdraws the request.
router.post('/request', bindingRateLimit, auth, async (req: express.Request & { user?: { id?: string } }, res: express.Response) => {
  try {
    const agentName = normalize(req.body?.agentName);
    const instanceId = normalize(req.body?.instanceId) || 'default';
    if (!agentName) return res.status(400).json({ message: 'agentName required' });
    const requestedMachineId = req.body?.machineId === null ? null : String(req.body?.machineId || '').trim();
    if (requestedMachineId === '') return res.status(400).json({ message: 'machineId required (null to withdraw)' });

    const ownership = await ownsAgent(req.user?.id, agentName, instanceId);
    if (!ownership.owned) {
      return res.status(403).json({
        message: ownershipFailureMessage[ownership.failure],
        code: ownership.failure,
      });
    }

    if (requestedMachineId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Machine = require('../models/Machine');
      const machine = await Machine.findOne({ machineId: requestedMachineId, ownerUserId: req.user?.id }).select('_id').lean();
      if (!machine) return res.status(404).json({ message: 'Machine not found' });
    }

    const identity = await User.findOne({
      isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId,
    }).select('botMetadata.machineId').lean();
    if (!identity) return res.status(404).json({ message: 'Agent identity not found' });
    if (requestedMachineId && identity.botMetadata?.machineId
        && identity.botMetadata.machineId !== requestedMachineId) {
      return res.status(409).json({
        message: 'Agent is bound to another machine — release it first',
        boundTo: identity.botMetadata.machineId,
      });
    }

    await User.updateOne(
      { _id: identity._id },
      { $set: { 'botMetadata.requestedMachineId': requestedMachineId } },
    );
    return res.json({
      requested: Boolean(requestedMachineId), agentName, instanceId, machineId: requestedMachineId,
    });
  } catch (err) {
    console.error('placement request error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ADR-026 Phase 2: the daemon's work list. Ownership authority is the
// installation set (same sole-installer basis as ownsAgent): start from the
// owner's active installations, then join to identities bound to — or
// requested onto — THIS machine (credential-derived machineId, never input).
router.get('/assigned', bindingRateLimit, daemonAuth('agents:adopt'), async (req: DaemonAuthedRequest, res: express.Response) => {
  try {
    const machine = req.machine!;
    if (!machine.machineId) return res.status(400).json({ message: 'Daemon credential carries no machineId' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AgentInstallation } = require('../models/AgentRegistry');
    const installs = await AgentInstallation.find({ installedBy: machine.ownerUserId, status: 'active' })
      .select('agentName instanceId podId config').lean();
    if (!installs.length) return res.json({ agents: [] });

    const byIdentity = new Map<string, { agentName: string; instanceId: string; podIds: string[]; runtime: unknown }>();
    for (const install of installs) {
      const agentName = normalize(install.agentName);
      const instanceId = normalize(install.instanceId) || 'default';
      const key = `${agentName} ${instanceId}`;
      // AgentInstallation.config is a Mongoose Map; lean() yields a plain
      // object, but stay defensive about both shapes.
      const config = install.config instanceof Map
        ? Object.fromEntries(install.config)
        : (install.config || {});
      const entry = byIdentity.get(key) || {
        agentName, instanceId, podIds: [], runtime: null,
      };
      if (install.podId) entry.podIds.push(String(install.podId));
      if (!entry.runtime && config.runtime) entry.runtime = config.runtime;
      byIdentity.set(key, entry);
    }

    const identities = await User.find({
      isBot: true,
      $or: [
        { 'botMetadata.machineId': machine.machineId },
        { 'botMetadata.requestedMachineId': machine.machineId },
      ],
    }).select('botMetadata.agentName botMetadata.instanceId botMetadata.machineId botMetadata.requestedMachineId').lean();

    const agents = identities.flatMap((identity: { botMetadata?: Record<string, unknown> }) => {
      const meta = identity.botMetadata || {};
      const key = `${normalize(meta.agentName)} ${normalize(meta.instanceId) || 'default'}`;
      const entry = byIdentity.get(key);
      // An identity outside the owner's installation set (shared, or another
      // user's) never appears in this daemon's work list.
      if (!entry) return [];
      return [{
        agentName: entry.agentName,
        instanceId: entry.instanceId,
        state: meta.machineId === machine.machineId ? 'bound' : 'requested',
        podIds: entry.podIds,
        runtime: entry.runtime,
      }];
    });
    return res.json({ agents });
  } catch (err) {
    console.error('assigned list error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// ADR-026 Phase 2 (D4.5 consumer): mint the runtime credential for an agent
// BOUND to this machine, as a child of this machine's daemon credential —
// lineage makes machine removal revoke it transitively. If a token already
// exists it lives on some other machine's disk; rotate:true is the explicit
// "this machine takes over" step and invalidates the old token everywhere.
router.post('/runtime-token', bindingRateLimit, daemonAuth('agents:adopt'), async (req: DaemonAuthedRequest, res: express.Response) => {
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

    const agentUser = await User.findOne({
      isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId,
    });
    if (!agentUser) return res.status(404).json({ message: 'Agent identity not found' });
    if (agentUser.botMetadata?.machineId !== machine.machineId) {
      return res.status(409).json({
        message: 'Agent is not bound to this machine — adopt it first',
        boundTo: agentUser.botMetadata?.machineId || null,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentCredential = require('../models/AgentCredential');
    const hasToken = (agentUser.agentRuntimeTokens || []).length > 0;
    if (hasToken && req.body?.rotate !== true) {
      return res.status(409).json({
        message: 'Agent already has a runtime token — pass rotate:true to invalidate it and mint one for this machine',
        code: 'token_exists',
      });
    }
    if (hasToken) {
      // Rotation must be total: revoke the ledger rows AND clear both legacy
      // stores (User + installation copies), or the old bearer keeps working
      // through the legacy auth fallback.
      const hashes = (agentUser.agentRuntimeTokens || []).map((t: { tokenHash: string }) => t.tokenHash);
      await AgentCredential.updateMany(
        { tokenHash: { $in: hashes }, kind: 'runtime' },
        { $set: { status: 'revoked', revokedAt: new Date() } },
      );
      agentUser.agentRuntimeTokens = [];
      await agentUser.save();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AgentInstallation } = require('../models/AgentRegistry');
      await AgentInstallation.updateMany({ agentName, instanceId }, { $set: { runtimeTokens: [] } });
    }

    // req.machine is deliberately a minimal projection (Vera's S1 ruling), so
    // re-derive the issuing daemon credential for parent lineage.
    const daemonCredential = await AgentCredential.findOne({
      kind: 'daemon', machineId: machine.machineId, ownerUserId: machine.ownerUserId, status: 'active',
    }).select('_id').lean();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { issueRuntimeTokenForAgent } = require('./registry/tokens');
    const minted = await issueRuntimeTokenForAgent(agentUser, `Daemon mint (${machine.machineId})`, null, {
      ownerUserId: machine.ownerUserId,
      parentId: daemonCredential?._id || null,
      machineId: machine.machineId,
    });
    return res.status(201).json({
      agentName, instanceId, token: minted.token, rotated: hasToken,
    });
  } catch (err) {
    console.error('runtime-token mint error:', err);
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
      // Withdraw any pending placement too — a release means "stop running
      // this anywhere", not "fail over to the requested machine".
      { $set: { 'botMetadata.machineId': null, 'botMetadata.requestedMachineId': null } },
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
