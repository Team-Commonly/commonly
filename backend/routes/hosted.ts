/**
 * /api/hosted — the "Run it here" surface (ADR-023 W2).
 *
 * A user installs an agent with `config.runtime.runtimeType: 'hosted'` through
 * the ordinary registry install (which is where the per-user agent cap is
 * enforced), then calls POST /provision here. This route mints the agent's
 * runtime token server-side and hands it to the hosted runtime with the
 * operator's admin bearer — the browser never sees either secret, and the
 * terminal step a stranger would otherwise hit simply is not there.
 *
 * Ownership is the sole-installer predicate: the caller must be the
 * `installedBy` of an active installation for that identity. Admins get no
 * bypass here; provisioning someone else's agent is not an ops action.
 */
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';

const auth = require('../middleware/auth');
const { AgentInstallation } = require('../models/AgentRegistry');
const User = require('../models/User');
const AgentIdentityService = require('../services/agentIdentityService');
const hostedRuntime = require('../services/hostedRuntimeService');
const { issueRuntimeTokenForAgent } = require('./registry/tokens');

const router = express.Router();

const hostedRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: { get?: (header: string) => string | undefined; ip?: string }) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: express.Response) => {
    res.status(429).json({ message: 'rate limit exceeded: 30 hosted-runtime requests per 60s' });
  },
});

const AGENT_NAME_RE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const INSTANCE_RE = /^[a-z0-9-]+$/;

const getUserId = (req: any) => req.userId || req.user?.id || req.user?._id;

/**
 * Resolve the identity the caller may act on. Returns the hydrated
 * installation (the token path saves onto it) or an error tuple.
 */
const resolveOwnedHostedInstallation = async (req: any, source: Record<string, any>) => {
  // Strip-via-replace is the shape CodeQL recognises as a sanitizer for the
  // Mongoose filter below; the round-trip check keeps validation strict
  // (a name that lost characters had invalid ones → 400, never a lookup of
  // a different identity). Same pattern as registry/install.
  const rawAgentName = String(source.agentName || '').toLowerCase();
  const rawInstanceId = String(source.instanceId || 'default').toLowerCase();
  const agentName = rawAgentName.replace(/[^a-z0-9@/-]/g, '');
  const instanceId = rawInstanceId.replace(/[^a-z0-9-]/g, '');
  if (!agentName || agentName !== rawAgentName || !AGENT_NAME_RE.test(agentName)) {
    return { error: { status: 400, body: { code: 'invalid_agent_name', message: 'agentName must match /^(@[a-z0-9-]+\\/)?[a-z0-9-]+$/' } } };
  }
  if (!instanceId || instanceId !== rawInstanceId || !INSTANCE_RE.test(instanceId)) {
    return { error: { status: 400, body: { code: 'invalid_instance_id', message: 'instanceId must match /^[a-z0-9-]+$/' } } };
  }
  const installation = await AgentInstallation.findOne({
    agentName,
    instanceId,
    status: 'active',
    installedBy: getUserId(req),
  });
  if (!installation) {
    return { error: { status: 404, body: { code: 'not_owner_or_missing', message: 'No active installation of that agent is owned by you' } } };
  }
  if (!hostedRuntime.isHostedInstallation(installation)) {
    return { error: { status: 409, body: { code: 'not_hosted', message: 'That agent was not installed with runtimeType "hosted"' } } };
  }
  return { installation, agentName, instanceId };
};

const requireConfigured = (res: express.Response): boolean => {
  if (hostedRuntime.isConfigured()) return true;
  res.status(503).json({
    code: 'hosted_runtime_unconfigured',
    message: 'Hosted runtime is not configured on this instance; connect your own agent instead.',
  });
  return false;
};

const relayWorkerError = (res: express.Response, error: any) => {
  if (error instanceof hostedRuntime.HostedRuntimeError) {
    return res.status(error.status).json({
      code: error.status === 503 ? 'hosted_runtime_unconfigured' : 'hosted_runtime_unreachable',
      message: error.message,
    });
  }
  console.error('[hosted] unexpected error:', error);
  return res.status(500).json({ message: 'Hosted runtime request failed' });
};

/**
 * POST /api/hosted/provision { agentName, instanceId? }
 */
router.post('/provision', hostedRateLimit, auth, async (req: any, res: any) => {
  try {
    if (!requireConfigured(res)) return undefined;
    const resolved = await resolveOwnedHostedInstallation(req, req.body || {});
    if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);
    const { installation, agentName, instanceId } = resolved;
    const userId = getUserId(req);

    // Defense in depth: the install route already refused the (N+1)th hosted
    // install, but a cap lowered after the fact must still stop provisioning.
    const { agentsPerUser } = hostedRuntime.hostedCaps();
    const owned = await hostedRuntime.countHostedAgentsForUser(userId);
    if (owned > agentsPerUser) {
      return res.status(403).json({
        code: 'hosted_cap_reached',
        message: `Hosted agents are capped at ${agentsPerUser} per user in beta`,
        used: owned,
        cap: agentsPerUser,
      });
    }

    const agentUser = await User.findOne({
      username: AgentIdentityService.buildAgentUsername(agentName, instanceId),
      isBot: true,
    });
    if (!agentUser) {
      return res.status(409).json({ code: 'identity_missing', message: 'Agent identity has not been created yet; reinstall the agent' });
    }

    const token = await issueRuntimeTokenForAgent(
      agentUser,
      'Hosted runtime',
      installation,
      { ownerUserId: userId },
    );
    await hostedRuntime.provisionAgent({ agentName, instanceId, runtimeToken: token.token });

    installation.config.set('hosted', { provisionedAt: new Date() });
    await installation.save();

    return res.json({
      provisioned: true,
      agentName,
      instanceId,
      podId: installation.podId,
      caps: hostedRuntime.hostedCaps(),
    });
  } catch (error) {
    return relayWorkerError(res, error);
  }
});

/**
 * POST /api/hosted/deprovision { agentName, instanceId? }
 * Stops the runtime. The installation and identity stay — ADR-001 §3 identity
 * continuity; re-provisioning finds the same memory and the same token.
 */
router.post('/deprovision', hostedRateLimit, auth, async (req: any, res: any) => {
  try {
    if (!requireConfigured(res)) return undefined;
    const resolved = await resolveOwnedHostedInstallation(req, req.body || {});
    if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);
    const { installation, agentName, instanceId } = resolved;
    await hostedRuntime.deprovisionAgent(agentName, instanceId);
    installation.config.set('hosted', { provisionedAt: null, deprovisionedAt: new Date() });
    await installation.save();
    return res.json({ deprovisioned: true, agentName, instanceId });
  } catch (error) {
    return relayWorkerError(res, error);
  }
});

/**
 * GET /api/hosted/status?agentName=&instanceId=
 * Runtime status plus today's meter, for the owner only.
 */
router.get('/status', hostedRateLimit, auth, async (req: any, res: any) => {
  try {
    if (!requireConfigured(res)) return undefined;
    const resolved = await resolveOwnedHostedInstallation(req, req.query || {});
    if (resolved.error) return res.status(resolved.error.status).json(resolved.error.body);
    const { agentName, instanceId } = resolved;
    const [runtime, meter] = await Promise.all([
      hostedRuntime.getAgentStatus(agentName, instanceId),
      hostedRuntime.meterAllowsTurn(agentName, instanceId),
    ]);
    return res.json({ agentName, instanceId, runtime, meter });
  } catch (error) {
    return relayWorkerError(res, error);
  }
});

module.exports = router;
export {};
