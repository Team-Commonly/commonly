// Plugin management routes — extracted from registry.js (GH#112)
const express = require('express');
const auth = require('../../middleware/auth');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  listOpenClawPlugins,
  installOpenClawPlugin,
  syncOpenClawSkills,
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeInstanceId,
  resolveInstallation,
  resolveGatewayForRequest,
  userHasPodAccess,
} = require('./helpers');

const pluginsRouter = express.Router({ mergeParams: true });

pluginsRouter.get('/pods/:podId/agents/:name/plugins', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
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

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }
    if (runtimeType !== 'moltbot') {
      return res.status(400).json({ error: 'Plugin management is only supported for OpenClaw' });
    }

    const { installation } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });
    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const plugins = await listOpenClawPlugins({ gateway });
    return res.json({
      runtimeType,
      ...plugins,
      gatewayId: gateway?._id || null,
      gatewaySlug: gateway?.slug || null,
    });
  } catch (error) {
    console.error('Error fetching OpenClaw plugins:', error);
    return res.status(500).json({ error: 'Failed to list plugins' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/plugins/install
 * Install an OpenClaw plugin in the selected/runtime gateway.
 */
pluginsRouter.post('/pods/:podId/agents/:name/plugins/install', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const {
      spec,
      pluginId,
      link = false,
      restart = false,
      instanceId,
      gatewayId,
    } = req.body || {};
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!spec || typeof spec !== 'string') {
      return res.status(400).json({ error: 'spec is required' });
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

    const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
    const runtimeType = typeConfig?.runtime;
    if (!runtimeType) {
      return res.status(400).json({ error: 'Unknown agent runtime type' });
    }
    if (runtimeType !== 'moltbot') {
      return res.status(400).json({ error: 'Plugin management is only supported for OpenClaw' });
    }

    const normalizedInstanceId = normalizeInstanceId(instanceId || 'default');
    const { installation, instanceId: resolvedInstanceId } = await resolveInstallation({
      agentName: name,
      podId,
      instanceId: normalizedInstanceId,
    });
    const effectiveInstanceId = resolvedInstanceId || normalizedInstanceId;
    const configPayload = normalizeConfigMap(installation?.config) || {};
    const configuredGatewayId = configPayload?.runtime?.gatewayId || null;
    let gateway = null;
    if (gatewayId) {
      gateway = await resolveGatewayForRequest({ gatewayId, userId });
    } else if (configuredGatewayId) {
      gateway = await resolveGatewayForInstallation({ gatewayId: configuredGatewayId });
    }

    const pluginReport = await listOpenClawPlugins({ gateway });
    const normalizedPluginId = normalizePluginIdentifier(pluginId);
    const specNormalized = normalizePluginIdentifier(spec);
    const specBase = getPluginSpecBase(spec);
    const candidates = new Set([
      normalizedPluginId,
      specNormalized,
      specBase,
    ].filter(Boolean));
    const existing = (pluginReport.plugins || []).find((plugin) => {
      const pluginIdValue = normalizePluginIdentifier(plugin?.id);
      const pluginNameValue = normalizePluginIdentifier(plugin?.name);
      return candidates.has(pluginIdValue) || candidates.has(pluginNameValue);
    });
    if (existing) {
      return res.status(409).json({
        error: 'Plugin already installed',
        plugin: existing,
        alreadyInstalled: true,
      });
    }

    const installResult = await installOpenClawPlugin({ spec, link: Boolean(link), gateway });
    let restartResult = null;
    if (restart) {
      restartResult = await restartAgentRuntime(runtimeType, effectiveInstanceId, { gateway });
    }

    return res.json({
      installed: true,
      spec,
      link: Boolean(link),
      restartRequired: true,
      output: installResult.stdout,
      errorOutput: installResult.stderr,
      command: installResult.command,
      restart: restartResult,
      gatewayId: gateway?._id || null,
      gatewaySlug: gateway?.slug || null,
    });
  } catch (error) {
    console.error('Error installing OpenClaw plugin:', error);
    return res.status(500).json({ error: 'Failed to install plugin' });
  }
});

/**
 * PATCH /api/registry/pods/:podId/agents/:name
 * Update agent configuration in a pod
 */
module.exports = pluginsRouter;
