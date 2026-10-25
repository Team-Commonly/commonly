// Runtime management routes — extracted from registry.js (GH#112)
// Handles: runtime-status, runtime-start, runtime-stop, runtime-restart, runtime-clear-sessions, runtime-logs
export {};
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
const express = require('express');
const auth = require('../../middleware/auth');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  clearAgentRuntimeSessions,
  resolveOpenClawAccountId,
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeInstanceId,
  normalizeConfigMap,
  isGlobalAdminUser,
  buildRuntimeLogFilters,
  resolveGatewayForRequest,
  resolveGatewayForInstallation,
  userHasPodAccess,
} = require('./helpers');

const runtimeRouter = express.Router({ mergeParams: true });
const runtimeRouteLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
});

// Emit once after dispatch, using only route/identity metadata.
const auditRuntimeRoute = (req: any, res: any, next: any) => {
  res.once('finish', () => {
    console.info(JSON.stringify({
      event: 'registry.runtime',
      route: req.route.path,
      podId: req.params.podId,
      agentName: req.params.name,
      instanceId: normalizeInstanceId(req.body?.instanceId || req.query.instanceId || 'default'),
      callerUserId: getUserId(req) || null,
      outcome: res.statusCode < 400 ? 'allowed' : res.statusCode,
    }));
  });
  next();
};

// Runtime routes share one authorization boundary before dispatching any
// adapter action. Use exact installation identity rather than legacy aliases.
const resolveAuthorizedRuntimeInstallation = async ({ podId, name, instanceId, userId }: any) => {
  const pod = await Pod.findById(podId).lean();
  if (!pod) {
    const error: any = new Error('Pod not found');
    error.status = 404;
    throw error;
  }
  const isAdmin = await isGlobalAdminUser(userId);
  if (!isAdmin && !userHasPodAccess(pod, userId)) {
    const error: any = new Error('Access denied');
    error.status = 403;
    throw error;
  }
  const installation = await AgentInstallation.findOne({
    agentName: String(name).toLowerCase(), podId, instanceId, status: { $ne: 'uninstalled' },
  });
  if (!installation) {
    const error: any = new Error('Agent installation not found');
    error.status = 404;
    throw error;
  }
  if (!isAdmin && installation.installedBy?.toString() !== userId.toString()) {
    const error: any = new Error('Access denied');
    error.status = 403;
    throw error;
  }
  return installation;
};

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-status
 * Check local runtime status (docker).
 */
runtimeRouter.get('/pods/:podId/agents/:name/runtime-status',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const instanceId = normalizeInstanceId(req.query.instanceId || 'default');
    const gatewayId = req.query.gatewayId || null;

    const installation = await resolveAuthorizedRuntimeInstallation({
      podId, name, instanceId: instanceId, userId,
    });
    const effectiveInstanceId = installation.instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const status = await getAgentRuntimeStatus(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, status, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error: unknown) {
    console.error('Error fetching runtime status:', error);
    if ((error as any).status) {
      return res.status((error as any).status).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'Failed to fetch runtime status' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-start
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-start',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const installation = await resolveAuthorizedRuntimeInstallation({
      podId, name, instanceId: normalizedInstanceId, userId,
    });
    const effectiveInstanceId = installation.instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const started = await startAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, started, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error: unknown) {
    console.error('Error starting runtime:', error);
    if ((error as any).status) {
      return res.status((error as any).status).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'Failed to start runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-stop
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-stop',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const installation = await resolveAuthorizedRuntimeInstallation({
      podId, name, instanceId: normalizedInstanceId, userId,
    });
    const effectiveInstanceId = installation.instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const stopped = await stopAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, stopped, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error: unknown) {
    console.error('Error stopping runtime:', error);
    if ((error as any).status) {
      return res.status((error as any).status).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'Failed to stop runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-restart
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-restart',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const installation = await resolveAuthorizedRuntimeInstallation({
      podId, name, instanceId: normalizedInstanceId, userId,
    });
    const effectiveInstanceId = installation.instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const restarted = await restartAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    return res.json({ runtimeType, restarted, gatewayId: gateway?._id || null, gatewaySlug: gateway?.slug || null });
  } catch (error: unknown) {
    console.error('Error restarting runtime:', error);
    if ((error as any).status) {
      return res.status((error as any).status).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'Failed to restart runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-clear-sessions
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-clear-sessions',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId, restart = true } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const installation = await resolveAuthorizedRuntimeInstallation({
      podId, name, instanceId: normalizedInstanceId, userId,
    });
    const effectiveInstanceId = installation.instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }
    if (runtimeType !== 'moltbot') {
      return res.status(400).json({ error: 'Session clearing is only supported for OpenClaw runtimes' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const accountId = resolveOpenClawAccountId({
      agentName: name,
      instanceId: effectiveInstanceId,
    });

    const cleared = await clearAgentRuntimeSessions(runtimeType, effectiveInstanceId, {
      gateway,
      accountId,
    });

    let restarted = null;
    if (restart) {
      restarted = await restartAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    }

    return res.json({
      runtimeType,
      accountId,
      cleared,
      restarted,
      gatewayId: gateway?._id || null,
      gatewaySlug: gateway?.slug || null,
    });
  } catch (error: unknown) {
    console.error('Error clearing runtime sessions:', error);
    if ((error as any).status) {
      return res.status((error as any).status).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'Failed to clear runtime sessions' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-logs
 */
runtimeRouter.get('/pods/:podId/agents/:name/runtime-logs',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const { podId, name } = req.params;
    const lines = Number(req.query.lines || 200);
    const instanceId = normalizeInstanceId(req.query.instanceId || 'default');
    const gatewayId = req.query.gatewayId || null;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const installation = await resolveAuthorizedRuntimeInstallation({
      podId, name, instanceId: instanceId, userId,
    });
    const effectiveInstanceId = installation.instanceId;

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }

    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const filterTokens = buildRuntimeLogFilters({ runtimeType, agentName: name, instanceId: effectiveInstanceId });
    const logs = await getAgentRuntimeLogs(runtimeType, effectiveInstanceId, lines, { gateway, filterTokens });
    return res.json({
      runtimeType,
      ...logs,
      gatewayId: gateway?._id || null,
      gatewaySlug: gateway?.slug || null,
    });
  } catch (error: unknown) {
    console.error('Error fetching runtime logs:', error);
    if ((error as any).status) {
      return res.status((error as any).status).json({ error: (error as Error).message });
    }
    return res.status(500).json({ error: 'Failed to fetch runtime logs' });
  }
});

module.exports = runtimeRouter;
