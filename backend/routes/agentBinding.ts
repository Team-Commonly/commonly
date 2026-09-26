// ADR-026 D3: identity-level machine binding. Adoption is an atomic
// conditional transition (unbound → bound(machineId)) on the agent's bot
// User row — the loser of a concurrent adopt gets a clean 409, never a
// second runner. Rebinding is explicit release-then-adopt. The bound-agent
// predicate is enforced HERE from the daemon credential's server-side
// machineId — never from a caller-supplied value.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { createHash } from 'crypto';
import daemonAuth, { DaemonAuthedRequest } from '../middleware/daemonAuth';
import { GRANT_BROKER_ID, GRANT_BROKER_URL } from '../services/installable/toolInstallables';
import { GrantBrokerRefusal, grantBrokerRefusal } from '../services/grantBrokerConfinement';
import {
  grantBrokerServer,
  selectLiveGrantsForIdentities,
} from '../services/grantBrokerProjectionService';
import {
  projectSeatEnvironments,
  seatEnvironmentKey,
} from '../services/seatEnvironmentProjection';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  getRuntimeTokenHashesForAgent,
  revokeRuntimeTokensForAgent,
} = require('./registry/tokens');

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
    return cloudflareIpRateLimitKeyGenerator(req as never);
  },
  handler: (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(429).json({ msg: 'rate limit exceeded: 120 binding ops per 60s' });
  },
});

const normalize = (v: unknown): string => String(v ?? '').trim().toLowerCase();
const RUNTIME_INSTALLATION_COLLATION = { locale: 'en', strength: 2 };


type AssignedIdentity = { _id?: unknown; botMetadata?: Record<string, unknown> };
type AssignmentEntry = { podIds: string[]; environment: Record<string, unknown> | null; runtime?: unknown };

/**
 * Project live room grants into a daemon assignment. Grants are capabilities,
 * not installation config: querying them means revoke and expiry take effect on
 * the next daemon poll without rewriting every AgentInstallation. Which grants
 * a seat has is not decided here — `selectLiveGrantsForIdentities` owns that
 * predicate and the hosted run path (TASK-132) asks the same question, so a
 * seat cannot be handed a capability one path projects and the other withholds.
 * What stays here is the daemon's own shape: the environment-confined refusal
 * and the MCP server naming.
 *
 * The grant is external reach, so it is only injected into an environment that
 * can confine it: a seat whose declaration no host would confine gets NO
 * broker servers and a typed refusal instead (TASK-063 — fail closed rather
 * than hand a seat a capability it cannot be held to). The refusal is a
 * top-level field on the assignment row, never inside `environment`, because
 * that object is spec-validated and handed to the adapter as-is.
 */
type IdentityGrantProjection = { servers: Record<string, unknown>[]; refusal: GrantBrokerRefusal | null };
const grantServersForIdentities = async (
  identities: AssignedIdentity[],
  entries: Map<string, AssignmentEntry>,
): Promise<Map<string, IdentityGrantProjection>> => {
  const identityIds = identities
    .map((identity) => String(identity._id || ''))
    .filter(Boolean);
  if (!identityIds.length) return new Map();

  // One predicate for both delivery paths (TASK-132): the daemon projects for
  // every pod the seat is installed in, and a hosted run passes only its own
  // pod. Neither path decides for itself what "live, audience, target" means.
  const liveGrants = await selectLiveGrantsForIdentities({
    identityIds,
    podIds: Array.from(new Set(Array.from(entries.values()).flatMap((entry) => entry.podIds))),
  });
  if (!liveGrants.size) return new Map();

  const output = new Map<string, IdentityGrantProjection>();
  for (const identityId of identityIds) {
    const grants = liveGrants.get(identityId) || [];
    const entry = identities
      .find((identity) => String(identity._id || '') === identityId);
    const meta = entry?.botMetadata || {};
    const key = `${normalize(meta.agentName)}\0${normalize(meta.instanceId) || 'default'}`;
    const assigned = entries.get(key);
    if (!assigned) continue;
    const existingMcp = Array.isArray(assigned.environment?.mcp) ? assigned.environment.mcp : [];
    const usedNames = new Set(
      existingMcp
        // The builtin component is a template only; once a live grant exists,
        // replace that placeholder entry with the grant-specific URL below.
        .filter((server: Record<string, unknown>) => !(
          server?.name === GRANT_BROKER_ID && server?.url === GRANT_BROKER_URL
        ))
        .map((server: Record<string, unknown>) => server?.name)
        .filter((name: unknown): name is string => typeof name === 'string'),
    );
    const refusal = grantBrokerRefusal(assigned.environment, assigned.runtime);
    const servers: Record<string, unknown>[] = [];
    let refused = false;
    for (const grant of grants) {
      const grantId = typeof grant.grantId === 'string' ? grant.grantId : '';
      if (!grantId) continue;
      if (refusal) {
        // The grant is live and applies to this seat; the seat cannot be held
        // to it, so it is withheld rather than projected unenforced.
        refused = true;
        continue;
      }

      let serverName = GRANT_BROKER_ID;
      if (usedNames.has(serverName)) serverName = `${GRANT_BROKER_ID}-${grantId}`;
      usedNames.add(serverName);
      servers.push(grantBrokerServer(grantId, serverName));
    }
    if (servers.length || refused) {
      output.set(identityId, { servers, refusal: refused ? refusal : null });
    }
  }
  return output;
};

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
  }).collation(RUNTIME_INSTALLATION_COLLATION).select('_id').lean();
  if (!mine) return { owned: false, failure: 'owner_installation_missing' };
  const others = await AgentInstallation.findOne({
    agentName, instanceId, status: 'active', installedBy: { $ne: ownerUserId },
  }).collation(RUNTIME_INSTALLATION_COLLATION).select('installedBy').lean();
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
    // The projection is shared with the grant read (TASK-063): one definition
    // of what a seat receives, so the read cannot disagree with the daemon.
    const byIdentity = await projectSeatEnvironments({ installedBy: machine.ownerUserId });
    if (!byIdentity.size) return res.json({ agents: [] });

    const identities = await User.find({
      isBot: true,
      $or: [
        { 'botMetadata.machineId': machine.machineId },
        { 'botMetadata.requestedMachineId': machine.machineId },
      ],
    }).select('_id botMetadata.agentName botMetadata.instanceId botMetadata.machineId botMetadata.requestedMachineId').lean() as AssignedIdentity[];

    const grantServers = await grantServersForIdentities(identities, byIdentity);

    const agents = identities.flatMap((identity: AssignedIdentity) => {
      const meta = identity.botMetadata || {};
      const key = seatEnvironmentKey(meta.agentName, meta.instanceId);
      const entry = byIdentity.get(key);
      // An identity outside the owner's installation set (shared, or another
      // user's) never appears in this daemon's work list.
      if (!entry) return [];
      const agentId = String(identity._id || '');
      const grantProjection = grantServers.get(agentId);
      const brokerServers = grantProjection?.servers || [];
      const environment = entry.environment
        ? {
          ...entry.environment,
          ...(brokerServers.length
            ? {
              mcp: [
                ...(Array.isArray(entry.environment.mcp) ? entry.environment.mcp : [])
                  .filter((server: any) => !brokerServers.some((broker) => broker.name === server?.name)),
                ...brokerServers,
              ],
            }
            : {}),
        }
        : (brokerServers.length ? { mcp: brokerServers } : null);
      return [{
        agentName: entry.agentName,
        instanceId: entry.instanceId,
        state: meta.machineId === machine.machineId ? 'bound' : 'requested',
        podIds: entry.podIds,
        runtime: entry.runtime,
        ...(environment ? { environment } : {}),
        // Why a live grant is not on this row, for the daemon that would
        // otherwise have to guess: server-side refusals only (a daemon-side
        // refusal is a separate reporting channel, TASK-063).
        ...(grantProjection?.refusal ? { grantBrokerRefusal: grantProjection.refusal } : {}),
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

    // Runtime auth accepts both the portable User row and legacy installation
    // copies. Count both stores before deciding whether rotate is required.
    const runtimeTokenHashes = await getRuntimeTokenHashesForAgent({
      agentUser,
      agentName,
      instanceId,
    });
    const hasToken = runtimeTokenHashes.length > 0;
    if (hasToken && req.body?.rotate !== true) {
      return res.status(409).json({
        message: 'Agent already has a runtime token — pass rotate:true to invalidate it and mint one for this machine',
        code: 'token_exists',
      });
    }
    if (hasToken) {
      await revokeRuntimeTokensForAgent({ agentUser, agentName, instanceId });
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AgentCredential = require('../models/AgentCredential');

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
