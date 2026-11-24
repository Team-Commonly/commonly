// Runtime management routes — extracted from registry.js (GH#112)
// Handles: runtime-status, runtime-start, runtime-stop, runtime-restart, runtime-logs
// (runtime-clear-sessions only served the retired OpenClaw gateway; plugins.ts
// answers it 410.)
export {};
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
const express = require('express');
const auth = require('../../middleware/auth');
const AgentIdentityService = require('../../services/agentIdentityService');
const {
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
} = require('../../services/agentProvisionerService');
const { moltbotRuntimeRetired, RUNTIME_RETIRED_BODY } = require('../../services/retiredRuntime');
const {
  getUserId,
  getRequestedInstanceId,
  resolveAuthorizedInstallation,
} = require('./helpers');

const runtimeRouter = express.Router({ mergeParams: true });
const runtimeRouteLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
});

const getAuditInstanceId = (req: any): string => {
  try {
    return getRequestedInstanceId(req);
  } catch {
    return 'invalid';
  }
};

// Emit once after dispatch, using only route/identity metadata.
const auditRuntimeRoute = (req: any, res: any, next: any) => {
  res.once('finish', () => {
    console.info(JSON.stringify({
      event: 'registry.runtime',
      route: req.route.path,
      podId: req.params.podId,
      agentName: req.params.name,
      instanceId: getAuditInstanceId(req),
      callerUserId: getUserId(req) || null,
      outcome: res.statusCode < 400 ? 'allowed' : res.statusCode,
    }));
  });
  next();
};

// Authorize, resolve the runtime type, and refuse a retired runtime before
// anything is dispatched. Answers the response itself and returns null when
// the route must stop.
const resolveRuntimeTarget = async (req: any, res: any) => {
  const { podId, name } = req.params;
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const instanceId = getRequestedInstanceId(req);
  const installation = await resolveAuthorizedInstallation({
    podId, name, instanceId, userId,
  });
  const typeConfig = AgentIdentityService.getAgentTypeConfig(name);
  const runtimeType = typeConfig?.runtime;
  if (!runtimeType) {
    res.status(400).json({ error: 'Unknown agent runtime type' });
    return null;
  }
  // A stored OpenClaw (moltbot) row has no gateway left to start, stop, read
  // or restart (ADR-021).
  if (moltbotRuntimeRetired(runtimeType)) {
    res.status(410).json(RUNTIME_RETIRED_BODY);
    return null;
  }
  return { runtimeType, instanceId: installation.instanceId };
};

const sendRuntimeError = (res: any, error: unknown, label: string, fallback: string) => {
  console.error(label, error);
  if ((error as any).status) {
    return res.status((error as any).status).json({ error: (error as Error).message });
  }
  return res.status(500).json({ error: fallback });
};

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-status
 * Check local runtime status (docker).
 */
runtimeRouter.get('/pods/:podId/agents/:name/runtime-status',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const target = await resolveRuntimeTarget(req, res);
    if (!target) return undefined;
    const status = await getAgentRuntimeStatus(target.runtimeType, target.instanceId);
    return res.json({ runtimeType: target.runtimeType, status });
  } catch (error: unknown) {
    return sendRuntimeError(res, error, 'Error fetching runtime status:', 'Failed to fetch runtime status');
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-start
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-start',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const target = await resolveRuntimeTarget(req, res);
    if (!target) return undefined;
    const started = await startAgentRuntime(target.runtimeType, target.instanceId);
    return res.json({ runtimeType: target.runtimeType, started });
  } catch (error: unknown) {
    return sendRuntimeError(res, error, 'Error starting runtime:', 'Failed to start runtime');
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-stop
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-stop',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const target = await resolveRuntimeTarget(req, res);
    if (!target) return undefined;
    const stopped = await stopAgentRuntime(target.runtimeType, target.instanceId);
    return res.json({ runtimeType: target.runtimeType, stopped });
  } catch (error: unknown) {
    return sendRuntimeError(res, error, 'Error stopping runtime:', 'Failed to stop runtime');
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/runtime-restart
 */
runtimeRouter.post('/pods/:podId/agents/:name/runtime-restart',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const target = await resolveRuntimeTarget(req, res);
    if (!target) return undefined;
    const restarted = await restartAgentRuntime(target.runtimeType, target.instanceId);
    return res.json({ runtimeType: target.runtimeType, restarted });
  } catch (error: unknown) {
    return sendRuntimeError(res, error, 'Error restarting runtime:', 'Failed to restart runtime');
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/runtime-logs
 */
runtimeRouter.get('/pods/:podId/agents/:name/runtime-logs',
  auditRuntimeRoute, runtimeRouteLimit, auth, async (req: any, res: any) => {
  try {
    const requestedLines = Number(req.query.lines ?? 200);
    const lines = Number.isFinite(requestedLines)
      ? Math.min(1000, Math.max(1, Math.trunc(requestedLines))) : 200;
    const target = await resolveRuntimeTarget(req, res);
    if (!target) return undefined;
    const logs = await getAgentRuntimeLogs(target.runtimeType, target.instanceId, lines);
    return res.json({ runtimeType: target.runtimeType, ...logs });
  } catch (error: unknown) {
    return sendRuntimeError(res, error, 'Error fetching runtime logs:', 'Failed to fetch runtime logs');
  }
});

module.exports = runtimeRouter;
