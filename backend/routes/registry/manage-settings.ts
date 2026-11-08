// Owner/admin controls for one agent installation at a time.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
import { hostedCapsForOwner, isHostedInstallation, userRunCeilingForOwner } from '../../services/hostedRuntimeService';
import { HOSTED_HEARTBEAT_MIN_INTERVAL_MINUTES, hostedHeartbeatRunsPerDay, hostedRunsNative } from '../../services/hostedEngine';
import { projectSeatEnvironments, seatEnvironmentKey } from '../../services/seatEnvironmentProjection';
import { HARNESS_CATALOG } from '../../config/harnessCatalog';
import { invalidScheduleField, isBareStop, takesSchedule } from '../../services/agentScheduleService';
import { ownsRuntimeIdentity } from '../../services/runtimeIdentityOwnership';
import { runtimeNarrowingStatus } from '../../services/outsiderGrantNarrowingPreview';
const { ownKeyCapability } = require('../../services/agentProviderKey');
const { installationIdentityFilter } = require('../../services/agentInstallationIdentity');
const Machine = require('../../models/Machine');
const AgentCredential = require('../../models/AgentCredential');
const { deriveAgentConnection } = require('../../services/agentConnectionStateService');
const AgentRuntimeObservation = require('../../models/AgentRuntimeObservation');
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const { getUserId, normalizeConfigMap, normalizeInstanceId } = require('./helpers');

const router = express.Router();
const settingsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: unknown) => cloudflareIpRateLimitKeyGenerator(req as never),
  handler: (_req: unknown, res: any) => res.status(429).json({ code: 'rate_limited' }),
});

const canManage = (installation: any, userId: string, isAdmin: boolean) => (
  isAdmin || String(installation.installedBy) === String(userId)
);

const WAKE_FLAGS = ['wakeOnMessage', 'humanOnly', 'boardWake', 'heartbeatEnabled'] as const;

// Names the first field a wake write got wrong, or null when the body is valid.
// The interval may be left out while the heartbeat is off; the stored one stays.
const invalidWakeField = (body: Record<string, unknown>) => {
  const flag = WAKE_FLAGS.find((key) => typeof body[key] !== 'boolean');
  if (flag) return { field: flag, error: `Invalid wake settings: ${flag} must be true or false` };
  const minutes = body.heartbeatMinutes;
  if (minutes === undefined && body.heartbeatEnabled === false) return null;
  if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 1440) {
    return { field: 'heartbeatMinutes',
      error: 'Invalid wake settings: heartbeatMinutes must be a whole number from 1 to 1440' };
  }
  return null;
};

// D244: a hosted install's heartbeat runs only on the native engine
// (hostedRunsNative, the predicate nativeRuntimeService gates
// hostedHeartbeatHold on), at most hourly, and within the owner's daily cap.
// A hosted install the engine doesn't run (the Durable Object, a deprovisioned
// row, an unfinished migration) runs no heartbeat at all, so it is told 0 and
// the panel says heartbeats aren't available. Per installation: runtimeType is
// a per-row field, so one identity's rows need not agree.
const hostedHeartbeatFor = (installation: any) => (isHostedInstallation(installation) ? {
  minMinutes: HOSTED_HEARTBEAT_MIN_INTERVAL_MINUTES,
  runsPerDay: hostedRunsNative(installation) ? hostedHeartbeatRunsPerDay() : 0,
} : null);

const settings = (installation: any, podName: string, podType?: string) => {
  const config = normalizeConfigMap(installation.config) || {};
  const wakeOnMessage = config.wakeOnMessage?.enabled === true;
  return {
    podId: String(installation.podId),
    podName,
    podType,
    status: installation.status,
    wakeOnMessage,
    humanOnly: config.wakeOnMessage?.humanOnly === true,
    boardWake: typeof config.boardWake?.enabled === 'boolean'
      ? config.boardWake.enabled : wakeOnMessage,
    heartbeatEnabled: config.heartbeat?.enabled === true,
    heartbeatMinutes: Number.isFinite(Number(config.heartbeat?.everyMinutes))
      && Number(config.heartbeat?.everyMinutes) > 0
      ? Math.max(1, Math.min(1440, Math.trunc(Number(config.heartbeat.everyMinutes)))) : 60,
    hostedHeartbeat: hostedHeartbeatFor(installation),
    schedule: config.schedule ? {
      enabled: config.schedule.enabled === true,
      time: config.schedule.time,
      timezone: config.schedule.timezone,
      prompt: config.schedule.prompt,
    } : null,
  };
};

// D247: the harnesses, models and effort levels an agent can be set to. The
// add-agent page reads it before any agent exists; Settings gets the same list
// on manage-settings.
router.get('/harness-catalog', settingsRateLimit, auth, (_req: any, res: any) => (
  res.json({ harnesses: HARNESS_CATALOG })
));

router.get('/agents/:name/manage-settings', settingsRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const isAdmin = (await User.findById(userId).select('role').lean())?.role === 'admin';
    const installations = await AgentInstallation.find({
      agentName: String(req.params.name).toLowerCase(),
      instanceId: normalizeInstanceId(req.query.instanceId),
      status: { $ne: 'uninstalled' },
    }).sort({ createdAt: 1, _id: 1 }).lean();
    const manageable = installations.filter((entry: any) => canManage(entry, userId, isAdmin));
    const pods = await Pod.find({ _id: { $in: manageable.map((entry: any) => entry.podId) } })
      .select('name type members').lean();
    const names = new Map<string, string>(pods.map((pod: any) => [String(pod._id), String(pod.name)]));
    const types = new Map<string, string | undefined>(pods.map((pod: any) => [String(pod._id), pod.type]));
    // Someone else's 1:1 room with this agent (ADR-001 §3.10). Its installer
    // manages the agent there, but isn't a member and doesn't learn who is: the
    // room reaches the response only as a count, never as a row, id or name.
    const othersRooms = new Set<string>(pods
      .filter((pod: any) => pod.type === 'agent-room'
        && !(pod.members || []).some((member: unknown) => String(member) === String(userId)))
      .map((pod: any) => String(pod._id)));
    const visible = manageable.filter((entry: any) => names.has(String(entry.podId)));
    const listed = visible.filter((entry: any) => !othersRooms.has(String(entry.podId)));
    const otherDirectRoomCount = visible.length - listed.length;
    const fallback = listed.find((entry: any) => entry.status === 'active') || listed[0]
      || visible.find((entry: any) => entry.status === 'active') || visible[0];
    const quotaOwner = fallback?.installedBy || userId;
    // The daemon runs the oldest active declaration, not whichever pod this
    // page happened to load first. Use its projection for both the displayed
    // controls and the installation selected for edits.
    const seat = (await projectSeatEnvironments({ installedBy: quotaOwner,
      agentName: req.params.name }))
      .get(seatEnvironmentKey(req.params.name, req.query.instanceId));
    const source = visible.find((entry: any) => String(entry.podId) === seat?.sourcePodId);
    const writable = fallback;
    const runtime = seat?.runtime && typeof seat.runtime === 'object' ? seat.runtime as Record<string, unknown> : {};
    const environment = seat?.environment || {};
    const runtimeControls = Object.fromEntries(['model', 'effort']
      .map((key) => [key, environment[key] ?? runtime[key]])
      .filter(([, value]) => typeof value === 'string'));
    for (const key of ['runtimeType', 'adapter']) {
      if (typeof runtime[key] === 'string') runtimeControls[key] = runtime[key];
    }
    const declaredProvider = environment.provider as { id?: string } | undefined;
    if (typeof declaredProvider?.id === 'string') runtimeControls.providerId = declaredProvider.id;
    if (runtime.host === 'cloud' || runtime.host === 'byo') runtimeControls.host = runtime.host;
    // The identity binding, rather than this pod's runtime declaration, tells
    // us whether the daemon owns the next spawn. A Settings write can make an
    // older pod the projection source even when it has no runtimeType field.
    const binding = await User.findOne({
      isBot: true,
      'botMetadata.agentName': String(req.params.name).toLowerCase(),
      'botMetadata.instanceId': normalizeInstanceId(req.query.instanceId),
    }).select('botMetadata.machineId agentRuntimeTokens.tokenHash agentRuntimeTokens.lastUsedAt '
      + 'agentRuntimeTokens.expiresAt').lean();
    const machine = binding?.botMetadata?.machineId ? await Machine.findOne({
      machineId: binding.botMetadata.machineId, ownerUserId: quotaOwner,
    }).select('runtimeInventory inventoryAt lastSeenAt').lean() : null;
    const observation = binding && machine ? await AgentRuntimeObservation.findOne({
      agentUserId: binding._id, machineId: binding.botMetadata.machineId,
    }).select('connectedAt lastSeenAt lastSpawn lastSpawnOutcome turnRunning lastTurnAt -_id').lean() : null;
    // The process line follows the agent's own credential use, as the roster
    // does. The machine heartbeat says the computer is online, not that this
    // agent's listener is.
    const credentials = binding && machine ? await AgentCredential.find({ kind: 'runtime', agentUserId: binding._id })
      .select('tokenHash status lastUsedAt expiresAt').lean() : [];
    const runtimeManaged = Boolean(binding?.botMetadata?.machineId);
    if (runtimeManaged && !runtimeControls.runtimeType) runtimeControls.runtimeType = 'wrapper';
    // D247: hosted and native turns read their own run config, so only they
    // stay read-only here. Every other agent the person owns is editable on
    // add and after: a daemon seat reads the projection, and a listener
    // (`agent run` with no machine binding) reads its installation's controls
    // from GET /api/agents/runtime/installations before each turn.
    const sourceRuntime = (normalizeConfigMap((source || writable)?.config) || {}).runtime || {};
    const hosted = runtime.host === 'cloud' || sourceRuntime.host === 'cloud'
      || ['hosted', 'internal', 'native'].includes(String(runtime.runtimeType || sourceRuntime.runtimeType || ''));
    const runtimeSavedControls = { ...runtimeControls };
    // A standalone `agent run` reads its local token record. Hosted/native
    // turns read their own run config (installation.config.model or the service
    // default), not the daemon projection. Neither path can be attested by an
    // installation runtime preference, so display only daemon-managed values.
    if (!runtimeManaged) {
      runtimeControls.model = '';
      runtimeControls.effort = '';
    }
    const [{ turnsPerDay }, userRunCeiling] = await Promise.all([
      hostedCapsForOwner(quotaOwner), userRunCeilingForOwner(quotaOwner),
    ]);
    // F164: the owner's readable form of runtime auth's 403
    // outsider_grant_runtime_narrowed. Same census and rule as the guard.
    const runtimeNarrowing = visible.length ? await runtimeNarrowingStatus({
      agentName: String(req.params.name).toLowerCase(),
      instanceId: normalizeInstanceId(req.query.instanceId),
      viewerId: userId,
    }) : null;
    // The agent-level line: the first hosted row the person can see. Each row
    // also carries its own bounds, which the wake panel applies per pod.
    const hostedRow = [source, writable, ...visible].find((entry) => entry && isHostedInstallation(entry));
    const hostedHeartbeat = hostedRow ? hostedHeartbeatFor(hostedRow) : null;
    return res.json({ turnCap: turnsPerDay, userRunCeiling, podCount: installations.length,
      runtimeNarrowing,
      hostedHeartbeat,
      activePodCount: installations.filter((entry: any) => entry.status === 'active').length,
      // The caller's own pod when they have one. With none, another person's
      // room is the only way to load and manage the agent; a bare id names no one.
      writablePodId: writable ? String(writable.podId) : null,
      runtimeSourcePodId: hosted ? null
        : source ? String(source.podId)
          : (!seat?.sourcePodId && writable ? String(writable.podId) : null),
      runtimeControls,
      runtimeSavedControls,
      ownKeyCapability: runtimeManaged ? ownKeyCapability(runtime, environment) : { available: false, provider: null },
      runtimeObservation: observation ? { ...observation, confirmed: null } : null,
      processConnected: machine ? deriveAgentConnection({ runtimeType: 'wrapper', credentials,
        embeddedTokens: binding?.agentRuntimeTokens || [] }).state === 'connected' : null,
      runtimeInventory: machine?.runtimeInventory || [],
      runtimeInventoryAt: machine?.inventoryAt || null,
      machineLastSeenAt: machine?.lastSeenAt || null,
      runtimeManaged,
      runtimeEditable: !hosted && Boolean(writable) && (!seat?.sourcePodId || Boolean(source)),
      harnessCatalog: HARNESS_CATALOG,
      otherDirectRoomCount,
      installations: listed
      .map((entry: any) => settings(entry, names.get(String(entry.podId)) || 'Pod', types.get(String(entry.podId)))) });
  } catch (error) {
    console.error('Error loading agent settings:', error);
    return res.status(500).json({ error: 'Failed to load agent settings' });
  }
});

router.patch('/agents/:name/manage-settings/pods/:podId', settingsRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const invalid = invalidWakeField(body);
    if (invalid) return res.status(400).json(invalid);
    const { wakeOnMessage, humanOnly, boardWake, heartbeatEnabled, heartbeatMinutes } = body;
    const installation = await AgentInstallation.findOne({
      agentName: String(req.params.name).toLowerCase(),
      instanceId: normalizeInstanceId(req.query.instanceId),
      podId: req.params.podId,
      status: { $ne: 'uninstalled' },
    });
    if (!installation) return res.status(404).json({ error: 'Agent not installed in this pod' });
    const isAdmin = (await User.findById(userId).select('role').lean())?.role === 'admin';
    if (!canManage(installation, userId, isAdmin)) return res.status(403).json({ error: 'Installer or admin required' });
    const config = normalizeConfigMap(installation.config) || {};
    installation.config = new Map(Object.entries({
      ...config,
      wakeOnMessage: { ...config.wakeOnMessage, enabled: wakeOnMessage, humanOnly },
      boardWake: { ...config.boardWake, enabled: boardWake },
      heartbeat: { ...config.heartbeat, enabled: heartbeatEnabled,
        ...(heartbeatMinutes === undefined ? {} : { everyMinutes: heartbeatMinutes }) },
    }));
    await installation.save();
    return res.json({ settings: settings(installation, '') });
  } catch (error) {
    console.error('Error saving agent settings:', error);
    return res.status(500).json({ error: 'Failed to save agent settings' });
  }
});

router.put('/agents/:name/manage-settings/pods/:podId/schedule', settingsRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const invalid = invalidScheduleField(body);
    if (invalid) return res.status(400).json(invalid);
    const installation = await AgentInstallation.findOne({
      ...installationIdentityFilter(String(req.params.name).toLowerCase(), normalizeInstanceId(req.query.instanceId)),
      podId: req.params.podId,
      status: { $ne: 'uninstalled' },
    });
    if (!installation) return res.status(404).json({ error: 'Agent not installed in this pod' });
    // Being this row's installer is not enough: a room or a mention writes a row
    // naming whoever opened it, and the wake runs on the owner's tools and
    // spend. The sole-installer rule, as for a push webhook, admins exempt.
    // Whoever manages the row can still stop what's on it, or someone else's
    // mention of the agent would lock its owner out. That write sets nothing else.
    const isAdmin = (await User.findById(userId).select('role').lean())?.role === 'admin';
    const ownership = isAdmin
      ? { owned: true as const }
      : await ownsRuntimeIdentity(userId, installation.agentName, installation.instanceId || 'default');
    const config = normalizeConfigMap(installation.config) || {};
    const onlyStopping = !ownership.owned && body.enabled === false && Boolean(config.schedule)
      && canManage(installation, userId, isAdmin);
    if (!ownership.owned && !onlyStopping) {
      return res.status(403).json({ code: ownership.failure, error: 'Only the agent\'s owner can schedule it' });
    }
    if (isBareStop(body) && !config.schedule) {
      return res.status(400).json({ code: 'no_schedule', error: 'This agent has no schedule to stop' });
    }
    // Stopping one needs no seat in the pod, starting one does, admins included.
    if (body.enabled && !(await Pod.exists({ _id: installation.podId, members: userId }))) {
      return res.status(403).json({ code: 'not_pod_member', error: 'Join this pod to schedule an agent in it' });
    }
    if (!takesSchedule({ ...installation.toObject(), config })) {
      return res.status(400).json({ code: 'schedule_byo_only', error: 'A schedule is for an agent you run yourself' });
    }
    // Field by field, so a save can't overwrite the dispatcher's claim on the day.
    const { enabled, time, timezone, prompt } = body;
    const stopping = onlyStopping || isBareStop(body);
    const fields = stopping ? { enabled } : { enabled, time, timezone, prompt: prompt.trim() };
    const saved = await AgentInstallation.findOneAndUpdate(
      // A reinstall can clear the schedule after the read, and a stop on its own
      // must not leave a schedule of just `enabled` behind.
      { _id: installation._id, ...(stopping ? { 'config.schedule': { $exists: true } } : {}) },
      { $set: Object.fromEntries(Object.entries(fields).map(([key, value]) => [`config.schedule.${key}`, value])) },
      { new: true },
    );
    if (!saved) return res.status(400).json({ code: 'no_schedule', error: 'This agent has no schedule to stop' });
    return res.json({ settings: settings(saved, '') });
  } catch (error) {
    console.error('Error saving agent schedule:', error);
    return res.status(500).json({ error: 'Failed to save agent schedule' });
  }
});

module.exports = router;
export {};
