import express from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import Integration from '../models/Integration';
import Pod from '../models/Pod';
import RoomGrant from '../models/RoomGrant';
import ToolCall from '../models/ToolCall';
import Machine from '../models/Machine';
import type { IRoomGrant } from '../models/RoomGrant';
import {
  assertGrantUsable,
  attenuateGrant,
  createGrant,
  effectiveAudience,
  revokeGrant,
  RoomGrantError,
} from '../services/roomGrantService';
import type { RoomGrantCreateInput } from '../services/roomGrantService';
import { emitConnectorsChanged } from '../services/connectorEventService';
import { resolveBrokerFor } from '../services/installable/toolInstallables';
import { grantBrokerRefusal } from '../services/grantBrokerConfinement';
import type { GrantBrokerRefusal } from '../services/grantBrokerConfinement';
import { projectSeatEnvironments, seatEnvironmentKey } from '../services/seatEnvironmentProjection';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DMService = require('../services/dmService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

const router = express.Router();

// The trail is read by the people in the room and by the seat it was granted
// to, so the calls route takes either identity — the shape reactions and
// artifacts use.
const dualAuth = (req: any, res: any, next: any) => {
  const bearer = ((req.header?.('Authorization') || '').replace('Bearer ', '')).trim();
  const altHeader = (req.header?.('x-commonly-agent-token') || '').trim();
  const token = bearer || altHeader;
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
};

const grantRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request): string => {
    const authHeader = req.get('Authorization') || req.get('x-auth-token');
    if (authHeader) return `grant:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    return cloudflareIpRateLimitKeyGenerator(req as never);
  },
  handler: (_req, res) => res.status(429).json({ message: 'rate limit exceeded: 60 grant operations per 60s' }),
});

interface AuthenticatedRequest extends express.Request {
  userId?: string;
}

/**
 * What the page may see of a grant (tools plan §6, Vera 67560/67568): the
 * explicit list and nothing else. `connectionId` and `brokerId` are the
 * broker's business; the raw `audience` snapshot still names agents who have
 * left, so only the effective audience goes out.
 */
type GrantRow = Pick<IRoomGrant, 'grantId' | 'installationId' | 'target' | 'tools' | 'writeMode' | 'budget'
  | 'expiresAt' | 'revokedAt' | 'revokedBy' | 'parentGrantId' | 'rootGrantId' | 'createdAt'> & { audience?: string[]; connectionId?: string };

const projectGrant = (
  grant: GrantRow,
  currentMembers: string[],
  grantedBy: string | null,
  confinement: GrantBrokerConfinement = NOT_EVALUATED,
) => ({
  grantId: grant.grantId,
  installationId: grant.installationId,
  target: { kind: grant.target.kind, id: grant.target.id },
  tools: [...(grant.tools || [])],
  writeMode: grant.writeMode,
  budget: grant.budget ? { calls: grant.budget.calls, windowMs: grant.budget.windowMs } : null,
  effectiveAudience: effectiveAudience(grant, currentMembers),
  expiresAt: grant.expiresAt,
  revokedAt: grant.revokedAt ?? null,
  revokedBy: grant.revokedBy ?? null,
  parentGrantId: grant.parentGrantId ?? null,
  rootGrantId: grant.rootGrantId ?? null,
  createdAt: grant.createdAt,
  grantedBy,
  // Why a live grant is not reaching the seat, decided by the same projection
  // that injects it (TASK-063). `scope` says what was JUDGED here, and a null
  // refusal therefore cannot mean two things: see GrantBrokerRefusalScope. The
  // honest limit is unchanged — a refusal the DAEMON made is not reported here
  // yet (the heartbeat carries four fields and Mongoose drops what the Machine
  // schema does not declare), so this pair says nothing about whether the
  // broker actually reached the seat.
  grantBrokerRefusal: confinement.refusal,
  grantBrokerRefusalScope: confinement.scope,
});

/** `grantedBy` is the Connection's owner (plan §9); one lookup per connection. */
const resolveGranters = async (connectionIds: string[]): Promise<Map<string, string | null>> => {
  const granters = new Map<string, string | null>();
  await Promise.all(Array.from(new Set(connectionIds)).map(async (connectionId) => {
    const connection = await findConnection(connectionId).catch(() => null);
    const owner = connectionOwnerId(connection);
    granters.set(connectionId, owner || null);
  }));
  return granters;
};

/**
 * What the read can say about the broker reaching a grant's seat.
 *
 * `scope` names what was JUDGED, never which layer decided — the deciding
 * layer is inside the refusal itself (`decidedBy`). The distinction is the
 * whole point of the field: a `null` refusal must not carry two meanings.
 *
 *  - `seat`          the seat's environment was resolved and judged; `null`
 *                    means checked and not refused.
 *  - `not_installed` the seat resolved to a governing owner, but that owner
 *                    has no installation of THIS identity and instance, so the
 *                    projection carries no row for the seat: nothing is
 *                    delivered to it and there is nothing to judge. Covers
 *                    both an owner with no installations and an owner whose
 *                    installations are all for other seats — what makes the
 *                    arm true is that THIS seat has no row (Vera 69890).
 *  - `unbound`       the seat could not be resolved to a governing
 *                    installation — it names no machine, or no identity to
 *                    bind — so NOTHING was judged. Deliberately not resolved
 *                    through the identity's installations: that is an ordering
 *                    guess, and for an unbound seat no daemon is polling it
 *                    anyway (Vera 69881).
 *  - `hosted`        the seat has no machine binding because it does not run on
 *                    a daemon at all: it runs on the hosted tier, where the
 *                    broker is handed to the run itself (TASK-132) and there is
 *                    no confinement layer to judge — nothing to confine (wren
 *                    73742). Without this, such a seat read as `unbound`, which
 *                    says the grant reaches nobody; that stopped being true the
 *                    moment a hosted run could redeem it.
 *  - `not_evaluated` the grant names a pod, not a seat. The refusal is a
 *                    property of each seat that redeems it and the projection
 *                    applies it per seat, so there is no single verdict to
 *                    report here.
 */
export type GrantBrokerRefusalScope =
  | 'seat'
  | 'not_installed'
  | 'unbound'
  | 'hosted'
  | 'not_evaluated';

export interface GrantBrokerConfinement {
  refusal: GrantBrokerRefusal | null;
  scope: GrantBrokerRefusalScope;
}

const NOT_EVALUATED: GrantBrokerConfinement = { refusal: null, scope: 'not_evaluated' };

/**
 * Would the daemon's own projection withhold the broker from these grants?
 *
 * The seat's environment is resolved through `projectSeatEnvironments` — the
 * same function `/assigned` builds the daemon work list from — through the
 * seat's own machine owner, which is the scope `/assigned` uses. Every grant
 * gets a verdict, including the ones that could not be judged.
 */
const seatGrantRefusals = async (grants: GrantRow[]): Promise<Map<string, GrantBrokerConfinement>> => {
  const confinements = new Map<string, GrantBrokerConfinement>();
  const seatGrants = grants.filter((grant) => grant.target.kind === 'seat'
    && typeof grant.target.id === 'string' && Types.ObjectId.isValid(grant.target.id));
  const judged = new Set(seatGrants.map((grant) => grant.grantId));
  for (const grant of grants) {
    if (!judged.has(grant.grantId)) confinements.set(grant.grantId, NOT_EVALUATED);
  }
  if (!seatGrants.length) return confinements;
  const seats = await User.find({ _id: { $in: seatGrants.map((grant) => grant.target.id) } })
    .select('botMetadata.agentName botMetadata.instanceId botMetadata.machineId')
    .lean();
  const seatsById = new Map(seats.map((seat: any) => [String(seat._id), seat]));
  const machineIds = Array.from(new Set(seats
    .map((seat: any) => seat?.botMetadata?.machineId)
    .filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))));
  const machines = machineIds.length
    ? await Machine.find({ machineId: { $in: machineIds } }).select('machineId ownerUserId').lean()
    : [];
  const ownersByMachine = new Map(machines.map((machine: any) => [String(machine.machineId), machine.ownerUserId]));
  const entries = new Map<string, any>();

  // Which seats are reached by a hosted run? Built from the same projection the
  // daemon reads, lazily — a workspace whose seat grants are all bound never
  // pays for it — and read through the same `sourced` rule, so this verdict
  // cannot disagree with what the run actually receives.
  let hostedSeats: Set<string> | null = null;
  const seatIsHosted = async (key: string): Promise<boolean> => {
    if (!hostedSeats) {
      hostedSeats = new Set<string>();
      const byIdentity = await projectSeatEnvironments();
      for (const [seatKey, entry] of byIdentity) {
        const runtime = entry.runtime as { runtimeType?: unknown } | null;
        if (String(runtime?.runtimeType || '').toLowerCase() === 'native') hostedSeats.add(seatKey);
      }
    }
    return hostedSeats.has(key);
  };

  for (const grant of seatGrants) {
    const seat: any = seatsById.get(String(grant.target.id));
    const meta = seat?.botMetadata || {};
    const identity = typeof meta.agentName === 'string' ? meta.agentName.trim() : '';
    const owner = typeof meta.machineId === 'string' ? ownersByMachine.get(meta.machineId) : undefined;
    if (!identity || !owner) {
      const key = identity ? seatEnvironmentKey(identity, meta.instanceId) : '';
      // eslint-disable-next-line no-await-in-loop -- one cached scan, only for seats that have no binding
      const hosted = key ? await seatIsHosted(key) : false;
      confinements.set(grant.grantId, hosted
        ? { refusal: null, scope: 'hosted' }
        : { refusal: null, scope: 'unbound' });
      continue;
    }
    const key = seatEnvironmentKey(identity, meta.instanceId);
    const cacheKey = `${key}\0${String(owner)}`;
    if (!entries.has(cacheKey)) {
      // eslint-disable-next-line no-await-in-loop
      const byIdentity = await projectSeatEnvironments({ installedBy: owner });
      entries.set(cacheKey, byIdentity.get(key) || null);
    }
    const entry = entries.get(cacheKey);
    // No entry means the owner's projection holds no row for this seat at all,
    // so the daemon is handed nothing and the broker reaches nobody. Reporting
    // that as `seat` + null would say "judged, not refused" about a seat that
    // was never delivered — the same two-meanings conflation the scope field
    // exists to prevent (Vera 69890).
    confinements.set(grant.grantId, entry
      ? { refusal: grantBrokerRefusal(entry.environment, entry.runtime), scope: 'seat' }
      : { refusal: null, scope: 'not_installed' });
  }
  return confinements;
};

const loadPod = async (podId: string) => (Types.ObjectId.isValid(podId)
  ? Pod.findById(podId).select('type members').lean()
  : null);

const memberIdsOf = (pod: { members?: unknown[] } | null): string[] => (pod?.members || [])
  .map((member: any) => String(member?._id ?? member));

const callerId = (req: AuthenticatedRequest): string => {
  const user = req.user as { id?: string; _id?: string } | undefined;
  return String(req.userId || user?.id || user?._id || '');
};

const findConnection = async (connectionId: string): Promise<any> => {
  if (Types.ObjectId.isValid(connectionId)) {
    const byId = await Integration.findById(connectionId);
    if (byId) return byId;
  }
  return Integration.findOne({ installationId: connectionId });
};

const connectionOwnerId = (connection: any): string => String(
  connection?.createdBy || connection?.config?.linkedUserId || '',
);

const getTargetMembers = async (target: { kind: 'pod' | 'seat'; id: string }): Promise<string[] | undefined> => {
  // Seat grants already identify their single target; there is no pod census
  // to intersect for them. The broker still checks the explicit audience.
  if (target.kind !== 'pod') return undefined;
  if (!Types.ObjectId.isValid(target.id)) {
    throw new RoomGrantError('invalid_target', 'target.id must be a valid pod id');
  }
  const pod = await Pod.findById(target.id).select('members').lean();
  if (!pod) throw new RoomGrantError('target_not_found', 'target pod not found', 404);
  return (pod.members || []).map((member: Types.ObjectId | string) => String(member));
};

const ensureTargetAccess = async (target: { kind: 'pod' | 'seat'; id: string }, userId: string): Promise<string[]> => {
  const members = (await getTargetMembers(target)) || [];
  if (target.kind === 'pod' && !members.includes(userId)) {
    throw new RoomGrantError('access_denied', 'caller is not a member of the target pod', 403);
  }
  return members;
};

const handleError = (res: express.Response, error: unknown): express.Response => {
  if (error instanceof RoomGrantError) {
    return res.status(error.statusCode).json({ error: error.code, message: error.message, details: error.details });
  }
  console.error('Room grant route error:', error);
  return res.status(500).json({ error: 'server_error', message: 'Server error' });
};

/** Mint a root grant. The connection owner is the granter; it is never taken from the body. */
router.post('/', grantRateLimit, auth, async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const body = (req.body || {}) as Record<string, any>;
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const connectionId = String(body.connectionId || '').trim();
    const connection = await findConnection(connectionId);
    if (!connection) return res.status(404).json({ error: 'connection_not_found' });
    if (connectionOwnerId(connection) !== userId) return res.status(403).json({ error: 'access_denied' });
    // The installation is the connection's, never the body's (Vera 67821):
    // a grant on connection A must not be able to name installation B.
    const installationId = String(connection.installationId || connection.config?.installationId || '').trim();
    if (connection.type !== 'github-app' || connection.status !== 'connected' || connection.revokedAt || !installationId) {
      return res.status(403).json({ error: 'connection_mismatch', message: 'connection is not a connected GitHub App installation' });
    }
    if (body.installationId !== undefined) {
      return res.status(400).json({ error: 'invalid_installation', message: 'installationId is set by the server from the connection, not the caller' });
    }

    const target = body.target;
    if (!target || (target.kind !== 'pod' && target.kind !== 'seat')) {
      return res.status(400).json({ error: 'invalid_target', message: 'target.kind must be pod or seat' });
    }
    const members = await ensureTargetAccess(target, userId);
    // Pod grants default to the current member snapshot. A seat has no pod
    // census, so its own seat id is the minimum audience and can be extended
    // explicitly by the granter.
    const audience = target.kind === 'seat'
      ? (body.audience === undefined ? [target.id] : body.audience)
      : (body.audience === undefined ? members : body.audience);
    const audienceValues = Array.isArray(audience) ? audience.map(String) : audience;
    if (
      target.kind === 'seat'
      && (!Array.isArray(audienceValues)
        || audienceValues.length !== 1
        || audienceValues[0] !== String(target.id))
    ) {
      return res.status(400).json({ error: 'invalid_audience', message: 'seat audience must be the target seat' });
    }
    if (
      target.kind === 'pod'
      && Array.isArray(audienceValues)
      && audienceValues.some((id: string) => !members.includes(id))
    ) {
      return res.status(400).json({ error: 'invalid_audience', message: 'audience must be current target members' });
    }

    // The broker is the catalogue's business, never the body's (Vera 67728):
    // a caller who names one is refused, the grant names the proxy the seeded
    // tool Installable points at, and may only allow tools that Installable
    // enables (tools plan §2, §6).
    if (body.brokerId !== undefined) {
      return res.status(400).json({ error: 'invalid_broker', message: 'brokerId is set by the server, not the caller' });
    }
    const broker = await resolveBrokerFor(String(connection.type));
    const requestedTools = Array.isArray(body.tools) ? body.tools.map(String) : [];
    const unknownTools = requestedTools.filter((tool: string) => !broker.enabledTools.includes(tool));
    if (unknownTools.length) {
      return res.status(400).json({
        error: 'invalid_tools',
        message: `tools not enabled by ${broker.installableId}: ${unknownTools.join(', ')}`,
      });
    }

    const grantInput: RoomGrantCreateInput = {
      connectionId,
      installationId,
      target,
      tools: body.tools,
      writeMode: body.writeMode,
      budget: body.budget,
      audience: audienceValues,
      expiresAt: body.expiresAt,
      brokerId: broker.brokerId,
    };
    const grant = await createGrant(grantInput);
    // The Connectors page lists this grant; every other tab this user has open
    // re-reads rather than waiting for a tab switch (TASK-135).
    emitConnectorsChanged(userId, 'grant-created');
    return res.status(201).json(grant);
  } catch (error) {
    return handleError(res, error);
  }
});

/** Agent-only delegation; all parent capabilities are loaded server-side. */
router.post(
  '/:grantId/attenuate',
  grantRateLimit,
  agentRuntimeAuth,
  async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const parent = await RoomGrant.findOne({ grantId: req.params.grantId });
    if (!parent) return res.status(404).json({ error: 'grant_not_found' });
    const agentId = String(req.agentUser?._id || '');
    if (!agentId) return res.status(401).json({ error: 'agent_identity_required' });
    const members = await getTargetMembers(parent.target);
    await assertGrantUsable({
      grant: parent,
      agentUserId: agentId,
      // Seat targets have no pod census; the explicit audience is the live
      // membership context for the seat-grant check.
      currentMemberIds: members ?? parent.audience,
    });
    const body = (req.body || {}) as Record<string, unknown>;
    const child = await attenuateGrant({
      parentGrantId: parent.grantId,
      tools: body.tools as string[] | undefined,
      writeMode: body.writeMode as any,
      budget: body.budget as any,
      audience: body.audience as string[] | undefined,
      expiresAt: body.expiresAt as string | undefined,
    });
    // Attenuation is agent-initiated, so the socket to invalidate is the
    // connection owner's, not the caller's: an agent has no Connectors page.
    // One lookup on an agent-only path, and a failure here must not fail the
    // mint that already happened.
    const connection = await findConnection(parent.connectionId).catch(() => null);
    emitConnectorsChanged(connectionOwnerId(connection), 'grant-attenuated');
    return res.status(201).json(child);
  } catch (error) {
    return handleError(res, error);
  }
  },
);

const revokeHandler = async (req: AuthenticatedRequest, res: express.Response): Promise<express.Response> => {
  try {
    const grant = await RoomGrant.findOne({ grantId: req.params.grantId });
    if (!grant) return res.status(404).json({ error: 'grant_not_found' });
    const userId = callerId(req);
    const connection = await findConnection(grant.connectionId);
    if (!connection || connectionOwnerId(connection) !== userId) {
      return res.status(403).json({ error: 'access_denied' });
    }
    const revoked = await revokeGrant(grant.grantId, userId);
    emitConnectorsChanged(userId, 'grant-revoked');
    return res.json({ grantId: grant.grantId, revoked });
  } catch (error) {
    return handleError(res, error);
  }
};

router.post('/:grantId/revoke', grantRateLimit, auth, revokeHandler);
router.delete('/:grantId', grantRateLimit, auth, revokeHandler);

/**
 * The trail (plan §6): one line per ToolCall, newest first, plus COUNT(*) by
 * outcome. Gated by canViewPod on the grant's target pod; a seat grant's trail
 * goes only to the granter and that seat. A line carries `argsDigest`, never
 * the arguments — the broker never stored them (ToolCall.digestArgs).
 */
/**
 * One gate for both reads (Vera 67727): a pod grant belongs to the pod, so
 * canViewPod decides for a human or a seat on its runtime token; a seat grant
 * goes only to the granter (the Connection's owner) and that seat.
 */
const gateGrantRead = async (
  grant: { target: { kind: 'pod' | 'seat'; id: string }; connectionId: string },
  req: AuthenticatedRequest,
): Promise<{ status: number; error: string } | { members: string[]; granter: string | null }> => {
  const agentId = (req as any).agentUser?._id ? String((req as any).agentUser._id) : '';
  const humanId = agentId ? '' : callerId(req);
  if (!agentId && !humanId) return { status: 401, error: 'unauthorized' };
  const granters = await resolveGranters([grant.connectionId]);
  const granter = granters.get(grant.connectionId) ?? null;
  if (grant.target.kind === 'seat') {
    const isGranter = Boolean(humanId) && granter === humanId;
    const isSeat = Boolean(agentId) && agentId === String(grant.target.id);
    if (!isGranter && !isSeat) return { status: 403, error: 'access_denied' };
    return { members: [], granter };
  }
  const pod = await loadPod(grant.target.id);
  if (!pod) return { status: 404, error: 'target_not_found' };
  if (!await DMService.canViewPod(agentId || humanId, pod)) return { status: 403, error: 'access_denied' };
  return { members: memberIdsOf(pod), granter };
};

/**
 * The trail (plan §6): one line per ToolCall, newest first, plus COUNT(*) by
 * outcome. A line carries `argsDigest`, never the arguments — the broker never
 * stored them (ToolCall.digestArgs).
 */
router.get('/:grantId/calls', grantRateLimit, dualAuth, async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const grant = await RoomGrant.findOne({ grantId: req.params.grantId }).lean();
    if (!grant) return res.status(404).json({ error: 'grant_not_found' });
    const gate = await gateGrantRead(grant, req);
    if ('status' in gate) return res.status(gate.status).json({ error: gate.error });

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.trunc(limitRaw)) : 100;
    const [rows, counts] = await Promise.all([
      ToolCall.listForGrant(grant.grantId, limit),
      ToolCall.countsForGrant(grant.grantId),
    ]);
    return res.json({
      grantId: grant.grantId,
      calls: rows.map((row) => ({
        callId: row.callId,
        agentUserId: row.agentUserId,
        tool: row.tool,
        outcome: row.outcome,
        reason: row.reason ?? null,
        approvalId: row.approvalId ?? null,
        argsDigest: row.argsDigest,
        at: row.at ?? null,
        durationMs: row.durationMs ?? null,
      })),
      counts,
    });
  } catch (error) {
    return handleError(res, error);
  }
});

// Read is gated exactly as the trail is, and projected: the explicit field
// list and nothing else — never connectionId, brokerId or the raw audience.
router.get('/:grantId', grantRateLimit, dualAuth, async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const grant = await RoomGrant.findOne({ grantId: req.params.grantId }).lean();
    if (!grant) return res.status(404).json({ error: 'grant_not_found' });
    const gate = await gateGrantRead(grant, req);
    if ('status' in gate) return res.status(gate.status).json({ error: gate.error });
    const currentMembers = grant.target.kind === 'seat' ? grant.audience : gate.members;
    const confinements = await seatGrantRefusals([grant]);
    return res.json(projectGrant(grant, currentMembers, gate.granter, confinements.get(grant.grantId)));
  } catch (error) {
    return handleError(res, error);
  }
});

/**
 * GET /api/pods/:podId/grants — every grant whose target is the pod or a seat
 * in it, gated by canViewPod, each row projected. Mounted under /api/pods by
 * server.ts beside the pod routes.
 */
const podGrantsRouter = express.Router();
podGrantsRouter.get('/:podId/grants', grantRateLimit, auth, async (req: AuthenticatedRequest, res: express.Response) => {
  try {
    const userId = callerId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const podId = String(req.params.podId || '');
    if (!Types.ObjectId.isValid(podId)) return res.status(403).json({ error: 'access_denied' });
    const pod = await loadPod(podId);
    if (!pod) return res.status(404).json({ error: 'pod_not_found' });
    if (!await DMService.canViewPod(userId, pod)) return res.status(403).json({ error: 'access_denied' });
    const members = memberIdsOf(pod);
    const grants = await RoomGrant.find({
      $or: [
        { 'target.kind': 'pod', 'target.id': podId },
        ...(members.length ? [{ 'target.kind': 'seat', 'target.id': { $in: members } }] : []),
      ],
    }).sort({ createdAt: -1 }).lean();
    const [granters, confinements] = await Promise.all([
      resolveGranters(grants.map((grant) => grant.connectionId)),
      seatGrantRefusals(grants),
    ]);
    return res.json({
      podId,
      grants: grants.map((grant) => projectGrant(
        grant,
        grant.target.kind === 'seat' ? grant.audience : members,
        granters.get(grant.connectionId) ?? null,
        confinements.get(grant.grantId),
      )),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

export { podGrantsRouter };
export default router;
module.exports = router;
module.exports.podGrantsRouter = podGrantsRouter;
