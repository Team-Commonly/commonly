// Owner/admin controls for one agent installation at a time.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
import { hostedCapsForOwner, userRunCeilingForOwner } from '../../services/hostedRuntimeService';
import { projectSeatEnvironments, seatEnvironmentKey } from '../../services/seatEnvironmentProjection';
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

router.get('/agents/:name/manage-settings', settingsRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const isAdmin = (await User.findById(userId).select('role').lean())?.role === 'admin';
    const installations = await AgentInstallation.find({
      agentName: String(req.params.name).toLowerCase(),
      instanceId: normalizeInstanceId(req.query.instanceId),
      status: { $ne: 'uninstalled' },
    }).lean();
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
    if (runtime.host === 'cloud' || runtime.host === 'byo') runtimeControls.host = runtime.host;
    // The identity binding, rather than this pod's runtime declaration, tells
    // us whether the daemon owns the next spawn. A Settings write can make an
    // older pod the projection source even when it has no runtimeType field.
    const binding = await User.findOne({
      isBot: true,
      'botMetadata.agentName': String(req.params.name).toLowerCase(),
      'botMetadata.instanceId': normalizeInstanceId(req.query.instanceId),
    }).select('botMetadata.machineId').lean();
    const runtimeManaged = Boolean(binding?.botMetadata?.machineId);
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
      runtimeSourcePodId: !runtimeManaged ? null
        : source ? String(source.podId)
          : (!seat?.sourcePodId && writable ? String(writable.podId) : null),
      runtimeControls,
      runtimeManaged,
      runtimeEditable: runtimeManaged && (!seat?.sourcePodId || Boolean(source)),
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
    const { wakeOnMessage, humanOnly, boardWake, heartbeatEnabled, heartbeatMinutes } = req.body || {};
    if (typeof wakeOnMessage !== 'boolean' || typeof boardWake !== 'boolean'
      || typeof humanOnly !== 'boolean' || typeof heartbeatEnabled !== 'boolean'
      || !Number.isInteger(heartbeatMinutes) || heartbeatMinutes < 1 || heartbeatMinutes > 1440) {
      return res.status(400).json({ error: 'Invalid wake settings' });
    }
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
      heartbeat: { ...config.heartbeat, enabled: heartbeatEnabled, everyMinutes: heartbeatMinutes },
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
