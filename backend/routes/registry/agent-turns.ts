// F669: "N turns today · M in the last 7 days" for a person's own agent, read by its owner only.
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../../middleware/ipRateLimit';
import { turnCounts } from '../../services/agentTurnCountService';
import { ownsRuntimeIdentity } from '../../services/runtimeIdentityOwnership';
import { IDENTITY_COLLATION } from '../../services/agentInstallationIdentity';

const express = require('express');
const auth = require('../../middleware/auth');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentRuntimeObservation = require('../../models/AgentRuntimeObservation');
const Machine = require('../../models/Machine');
const Pod = require('../../models/Pod');
const User = require('../../models/User');
const DMService = require('../../services/dmService');
const { cleanTimeZone } = require('../../utils/timeZone');
const { getUserId, normalizeInstanceId } = require('./helpers');

const router = express.Router();
const turnsRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: unknown) => cloudflareIpRateLimitKeyGenerator(req as never),
  handler: (_req: unknown, res: any) => res.status(429).json({ code: 'rate_limited' }),
});

const NOT_FOUND = { error: 'Agent not found' };

/**
 * The owner is the person who owns the agent's identity (ownsRuntimeIdentity,
 * the test agentProviderKey's context() applies) and whose computer runs it:
 * the turns are counted from that machine's spawn reports, on that person's
 * account. Both must hold, so a machine owner who no longer owns the agent
 * reads nothing. Anyone else,
 * admins included, gets the same 404 as for an agent that doesn't exist, so
 * the answer says nothing about whose agent it is. Per-pod rows name only pods
 * the owner can view (DMService.canViewPod); turns in any other pod, and turns
 * a runner reported with no pod, are one unnamed `elsewhere` count, so the
 * rows always sum to the total.
 */
router.get('/agents/:name/turns', turnsRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const agentName = String(req.params.name || '').toLowerCase();
    const instanceId = normalizeInstanceId(req.query.instanceId);
    const bot = await User.findOne({
      isBot: true, 'botMetadata.agentName': agentName, 'botMetadata.instanceId': instanceId,
    }).select('_id botMetadata.machineId').lean();
    const machineId = bot?.botMetadata?.machineId;
    const machine = machineId
      ? await Machine.findOne({ machineId }).select('ownerUserId').lean() : null;
    if (!machine || String(machine.ownerUserId) !== String(userId)) return res.status(404).json(NOT_FOUND);
    if (!(await ownsRuntimeIdentity(userId, agentName, instanceId)).owned) return res.status(404).json(NOT_FOUND);

    const [owner, observation] = await Promise.all([
      User.findById(userId).select('timezone').lean(),
      AgentRuntimeObservation.findOne({ agentUserId: bot._id }).select('recentTurns -_id').lean(),
    ]);
    const timeZone = cleanTimeZone(owner?.timezone) || 'UTC';
    const counts = turnCounts(observation?.recentTurns || [], timeZone);

    const podIds = counts.pods.map((pod) => pod.podId).filter((podId): podId is string => Boolean(podId));
    const [pods, installedIn] = podIds.length ? await Promise.all([
      Pod.find({ _id: { $in: podIds } }).select('name type members').lean(),
      AgentInstallation.distinct('podId', { agentName, instanceId, podId: { $in: podIds } })
        .collation(IDENTITY_COLLATION),
    ]) : [[], []];
    const installed = new Set((installedIn as unknown[]).map(String));
    const viewable = new Map<string, { name?: string; type?: string }>();
    await Promise.all(pods.map(async (pod: any) => {
      if (installed.has(String(pod._id)) && await DMService.canViewPod(userId, pod)) viewable.set(String(pod._id), pod);
    }));
    const elsewhere = { today: 0, week: 0 };
    const named: Array<Record<string, unknown>> = [];
    counts.pods.forEach((entry) => {
      const pod = entry.podId ? viewable.get(entry.podId) : undefined;
      if (!pod) {
        elsewhere.today += entry.today;
        elsewhere.week += entry.week;
        return;
      }
      named.push({
        podId: entry.podId, podName: pod.name || '', podType: pod.type, today: entry.today, week: entry.week,
      });
    });
    return res.json({
      timeZone, today: counts.today, week: counts.week, weekCapped: counts.weekCapped, pods: named, elsewhere,
    });
  } catch (error) {
    console.error('Error loading agent turn counts:', (error as Error).message);
    return res.status(500).json({ error: 'Failed to load turn counts' });
  }
});

module.exports = router;

export {};
