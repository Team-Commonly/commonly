// Owner/admin controls for one agent installation at a time.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
import { hostedCapsForOwner, userRunCeilingForOwner } from '../../services/hostedRuntimeService';
import { projectSeatEnvironments, seatEnvironmentKey } from '../../services/seatEnvironmentProjection';
import { HARNESS_CATALOG } from '../../config/harnessCatalog';
const { ownKeyCapability } = require('../../services/agentProviderKey');
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

const settings = (installation: any, podName: string) => {
  const config = normalizeConfigMap(installation.config) || {};
  const wakeOnMessage = config.wakeOnMessage?.enabled === true;
  return {
    podId: String(installation.podId),
    podName,
    status: installation.status,
    wakeOnMessage,
    humanOnly: config.wakeOnMessage?.humanOnly === true,
    boardWake: typeof config.boardWake?.enabled === 'boolean'
      ? config.boardWake.enabled : wakeOnMessage,
    heartbeatEnabled: config.heartbeat?.enabled === true,
    heartbeatMinutes: Number.isFinite(Number(config.heartbeat?.everyMinutes))
      && Number(config.heartbeat?.everyMinutes) > 0
      ? Math.max(1, Math.min(1440, Math.trunc(Number(config.heartbeat.everyMinutes)))) : 60,
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
      .select('name').lean();
    const names = new Map<string, string>(pods.map((pod: any) => [String(pod._id), String(pod.name)]));
    const visible = manageable.filter((entry: any) => names.has(String(entry.podId)));
    const fallback = visible.find((entry: any) => entry.status === 'active') || visible[0];
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
    return res.json({ turnCap: turnsPerDay, userRunCeiling, podCount: installations.length,
      activePodCount: installations.filter((entry: any) => entry.status === 'active').length,
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
      installations: visible
      .map((entry: any) => settings(entry, names.get(String(entry.podId)) || 'Pod')) });
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

module.exports = router;
export {};
