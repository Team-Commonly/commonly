export {};

import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';

const express = require('express');
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const { AgentInstallation } = require('../models/AgentRegistry');
const {
  HOOK_EVENT_TYPES,
  isHookEventType,
  processHookEvent,
} = require('../services/agentHookService');

const router = express.Router();

// CodeQL anchors on the first middleware in the chain.  Keep the limiter
// before agentRuntimeAuth: authentication performs a database lookup and a
// malformed/compromised token must not turn that lookup into a DoS primitive.
const hookRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => {
    const token = String(req.header('x-commonly-agent-token') || req.header('authorization') || '').trim();
    return token
      ? `token:${createHash('sha256').update(token).digest('hex')}`
      : `ip:${req.ip || 'unknown'}`;
  },
  handler: (_req: any, res: any) => res.status(429).json({
    code: 'rate_limited',
    message: 'hook rate limit exceeded',
  }),
});

const normalize = (value: unknown): string => String(value || '').trim().toLowerCase();

const resolveIdentity = (req: any): { agentName: string; instanceId: string } => ({
  agentName: normalize(
    req.agentUser?.botMetadata?.agentName
      || req.agentInstallation?.agentName
      || req.agentUser?.username,
  ),
  instanceId: String(
    req.agentUser?.botMetadata?.instanceId
      || req.agentInstallation?.instanceId
      || 'default',
  ),
});

const readLean = async (query: any): Promise<any> => {
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
};

const eventName = (body: any): unknown => body?.event || body?.hook_event_name || body?.event_name;

const sanitizeHookBody = (body: any, event: string, eventId: string) => ({
  event,
  eventId,
  ...(typeof body?.tool === 'string' ? { tool: body.tool } : {}),
  ...(typeof body?.tool_name === 'string' ? { tool: body.tool_name } : {}),
  ...(typeof body?.argsDigest === 'string' ? { argsDigest: body.argsDigest } : {}),
  ...(typeof body?.args_digest === 'string' ? { argsDigest: body.args_digest } : {}),
  ...(Array.isArray(body?.paths) ? { paths: body.paths.filter((value: any) => typeof value === 'string') } : {}),
});

/**
 * Claude/Codex hook ingress.  The endpoint returns the same decision for a
 * replayed (pod, agent, eventId) tuple and never echoes the event payload.
 */
router.post('/pods/:podId/hooks', hookRateLimit, agentRuntimeAuth, async (req: any, res: any) => {
  const podId = String(req.params.podId || '').trim();
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : null;
  const event = eventName(body);
  const eventId = typeof body?.eventId === 'string'
    ? body.eventId.trim()
    : (typeof body?.event_id === 'string' ? body.event_id.trim() : '');

  if (!podId || !body) {
    return res.status(400).json({ code: 'invalid_hook', message: 'a JSON object and podId are required' });
  }
  if (!isHookEventType(event)) {
    return res.status(400).json({
      code: 'invalid_event',
      message: `event must be one of ${HOOK_EVENT_TYPES.join(', ')}`,
    });
  }
  if (!eventId || eventId.length > 200 || /[\u0000-\u001f]/.test(eventId)) {
    return res.status(400).json({ code: 'invalid_event_id', message: 'eventId is required' });
  }

  const { agentName, instanceId } = resolveIdentity(req);
  if (!agentName) return res.status(401).json({ code: 'agent_identity_unresolved' });

  try {
    // agentRuntimeAuth authorizes a token globally.  This second lookup is
    // intentional: a token for pod A must not submit a hook for pod B.
    const installationQuery = AgentInstallation.findOne({
      agentName,
      instanceId,
      podId,
      status: 'active',
    });
    const installation = await readLean(installationQuery);
    if (!installation) {
      return res.status(403).json({ code: 'not_installed', message: 'agent is not installed in this pod' });
    }

    // Hook bodies are an ingress contract, not an event archive.  Keep only
    // the tool name, digest, and already-resolved paths; in particular never
    // pass Claude's raw tool_input (which may contain Write contents) onward.
    const payload = sanitizeHookBody(body, String(event), eventId);
    const result = await processHookEvent({
      podId,
      agentName,
      event,
      eventId,
      payload,
    });
    return res.status(result.statusCode).json(result.response);
  } catch (error: any) {
    // Do not include body/tool_input in diagnostics: hook payloads may carry
    // source, credentials, or command arguments. D7 is fail-open at this
    // runtime edge, so an unavailable ledger cannot invent a deny decision.
    return res.status(200).json({
      eventId,
      event,
      permissionDecision: 'allow',
      reason: 'hook_unavailable',
    });
  }
});

module.exports = router;
