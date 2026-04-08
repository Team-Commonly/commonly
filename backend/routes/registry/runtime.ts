// @ts-nocheck
// Runtime management routes — extracted from registry.js (GH#112)
// Handles: runtime-status, runtime-start, runtime-stop, runtime-restart, runtime-clear-sessions, runtime-logs
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
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeInstanceId,
  resolveInstallation,
  buildRuntimeLogFilters,
  resolveGatewayForRequest,
  userHasPodAccess,
} = require('./helpers');

const runtimeRouter = express.Router({ mergeParams: true });

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-status
 * Check local runtime status (docker).
 */
runtimeRouter.get('/pods/:podId/agents/:name/runtime-status', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const instanceId = normalizeInstanceId(req.query.instanceId || 'default');
    const gatewayId = req.query.gatewayId || null;

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || instanceId;

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
  } catch (error) {
    console.error('Error fetching runtime status:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch runtime status' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-start
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-start', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

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
  } catch (error) {
    console.error('Error starting runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to start runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-stop
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-stop', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

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
  } catch (error) {
    console.error('Error stopping runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to stop runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-restart
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-restart', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

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
  } catch (error) {
    console.error('Error restarting runtime:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to restart runtime' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-clear-sessions
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-clear-sessions', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, gatewayId, restart = true } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;

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
  } catch (error) {
    console.error('Error clearing runtime sessions:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to clear runtime sessions' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-logs
 */
runtimeRouter.get('/pods/:podId/agents/:name/runtime-logs', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const lines = Number(req.query.lines || 200);
    const instanceId = normalizeInstanceId(req.query.instanceId || 'default');
    const gatewayId = req.query.gatewayId || null;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || instanceId;

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
  } catch (error) {
    console.error('Error fetching runtime logs:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch runtime logs' });
  }
});

module.exports = runtimeRouter;
