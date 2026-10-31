/**
 * GET /api/agents/seat-activity?podId=&agentName=&instanceId=
 *
 * Recent inbox events and runs for one seat, for `commonly agent logs` on a
 * machine that does not run the seat. Member-gated: the caller must be a
 * member of the pod, and admin read access does not apply here. Returns event
 * types, statuses and runs. It never returns payloads, prompts, reply text or
 * tokens.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';

const auth = require('../middleware/auth');
const Pod = require('../models/Pod');
const AgentEvent = require('../models/AgentEvent');
const AgentRun = require('../models/AgentRun');

const router = express.Router();
const EVENT_LIMIT = 20;
const RUN_LIMIT = 5;

router.use(rateLimit({
  windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
}));

router.get('/', auth, async (req: any, res: express.Response) => {
  const userId = String(req.user?.id || req.userId || '');
  const podId = String(req.query.podId || '');
  const agentName = String(req.query.agentName || '').trim().toLowerCase();
  const instanceId = String(req.query.instanceId || 'default');
  if (!/^[a-f\d]{24}$/i.test(podId) || !agentName) {
    return res.status(400).json({ message: 'podId and agentName are required' });
  }
  try {
    const pod = await Pod.findById(podId).select('members').lean();
    const isMember = Boolean(pod)
      && (pod.members || []).some((member: unknown) => String(member) === userId);
    if (!isMember) {
      return res.status(403).json({ message: 'Not a member of this pod' });
    }
    const [events, runs] = await Promise.all([
      AgentEvent.find({ podId, agentName, instanceId })
        .sort({ createdAt: -1 })
        .limit(EVENT_LIMIT)
        .select('type status createdAt delivery.outcome')
        .lean(),
      AgentRun.find({ podId, agentName, instanceId })
        .sort({ startedAt: -1 })
        .limit(RUN_LIMIT)
        .select('trigger status startedAt totalTokens')
        .lean(),
    ]);
    return res.json({
      events: events.map((event: any) => ({
        type: event.type,
        status: event.status,
        createdAt: event.createdAt,
        outcome: event.delivery?.outcome ?? null,
      })),
      runs: runs.map((run: any) => ({
        trigger: run.trigger,
        status: run.status,
        startedAt: run.startedAt,
        totalTokens: run.totalTokens ?? 0,
      })),
    });
  } catch (error: any) {
    console.error('Error reading seat activity:', (error as Error).message || error);
    return res.status(500).json({ message: 'Failed to read seat activity' });
  }
});

module.exports = router;
