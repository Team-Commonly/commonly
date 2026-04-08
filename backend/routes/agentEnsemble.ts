// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line global-require
const AgentEnsembleService = require('../services/agentEnsembleService');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');

interface AuthReq {
  user?: { id: string };
  agentUser?: { botMetadata?: { agentName?: string; instanceId?: string } };
  agentInstallation?: { agentName?: string; instanceId?: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const checkEnsemblePod = async (podId: string) => Pod.findById(podId) as Promise<{ type?: string; members?: unknown[]; createdBy?: { toString: () => string }; agentEnsemble?: unknown; includes?: (id: string) => boolean } | null>;

router.post('/:podId/ensemble/start', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { topic, participants, maxMessages, maxRounds, maxDurationMinutes } = (req.body || {}) as { topic?: string; participants?: unknown; maxMessages?: number; maxRounds?: number; maxDurationMinutes?: number };
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (!pod.includes?.(req.user?.id || '')) return res.status(403).json({ error: 'Not a member of this pod' });
    const state = await AgentEnsembleService.startDiscussion(podId, { topic, participants, maxMessages, maxRounds, maxDurationMinutes, createdBy: req.user?.id }) as { _id: unknown; status?: string; topic?: string; participants?: unknown; turnState?: unknown };
    return res.status(201).json({ success: true, message: 'Discussion started', state: { id: state._id, status: state.status, topic: state.topic, participants: state.participants, turnState: state.turnState } });
  } catch (error) {
    console.error('Failed to start ensemble discussion:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

router.post('/:podId/ensemble/pause', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (!pod.includes?.(req.user?.id || '')) return res.status(403).json({ error: 'Not a member of this pod' });
    const state = await AgentEnsembleService.pauseDiscussion(podId) as { _id: unknown; status?: string; stats?: { pausedAt?: unknown }; turnState?: { turnNumber?: number } };
    return res.json({ success: true, message: 'Discussion paused', state: { id: state._id, status: state.status, pausedAt: state.stats?.pausedAt, turnNumber: state.turnState?.turnNumber } });
  } catch (error) {
    console.error('Failed to pause ensemble discussion:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

router.post('/:podId/ensemble/resume', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (!pod.includes?.(req.user?.id || '')) return res.status(403).json({ error: 'Not a member of this pod' });
    const state = await AgentEnsembleService.resumeDiscussion(podId) as { _id: unknown; status?: string; turnState?: { turnNumber?: number; currentAgent?: string } };
    return res.json({ success: true, message: 'Discussion resumed', state: { id: state._id, status: state.status, turnNumber: state.turnState?.turnNumber, currentAgent: state.turnState?.currentAgent } });
  } catch (error) {
    console.error('Failed to resume ensemble discussion:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

router.post('/:podId/ensemble/complete', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (!pod.includes?.(req.user?.id || '')) return res.status(403).json({ error: 'Not a member of this pod' });
    const completed = await AgentEnsembleService.completeActiveForPod(podId, 'manual') as { _id: unknown; status?: string; stats?: { completionReason?: string; totalMessages?: number }; summary?: unknown };
    return res.json({ success: true, message: 'Discussion completed', state: { id: completed._id, status: completed.status, completionReason: completed.stats?.completionReason, totalMessages: completed.stats?.totalMessages, summary: completed.summary } });
  } catch (error) {
    console.error('Failed to complete ensemble discussion:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

router.get('/:podId/ensemble/state', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (!pod.includes?.(req.user?.id || '')) return res.status(403).json({ error: 'Not a member of this pod' });
    const state = await AgentEnsembleService.getState(podId) as { _id: unknown; status?: string; topic?: string; participants?: unknown; turnState?: unknown; stats?: unknown; stopConditions?: unknown; keyPoints?: unknown[]; summary?: unknown } | null;
    if (!state) return res.json({ success: true, state: null, podConfig: pod.agentEnsemble || {} });
    return res.json({ success: true, state: { id: state._id, status: state.status, topic: state.topic, participants: state.participants, turnState: state.turnState, stats: state.stats, stopConditions: state.stopConditions, keyPoints: state.keyPoints?.slice(-5), summary: state.summary }, podConfig: pod.agentEnsemble || {} });
  } catch (error) {
    console.error('Failed to get ensemble state:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

router.patch('/:podId/ensemble/config', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { enabled, topic, participants, stopConditions, schedule, humanParticipation } = (req.body || {}) as { enabled?: boolean; topic?: string; participants?: unknown; stopConditions?: unknown; schedule?: unknown; humanParticipation?: unknown };
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (pod.createdBy?.toString() !== req.user?.id) {
      const user = await User.findById(req.user?.id).select('role') as { role?: string } | null;
      if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Only pod creator or global admin can update config' });
    }
    const config: Record<string, unknown> = {};
    if (enabled !== undefined) config.enabled = enabled;
    if (topic !== undefined) config.topic = topic;
    if (participants !== undefined) config.participants = participants;
    if (stopConditions !== undefined) config.stopConditions = stopConditions;
    if (schedule !== undefined) config.schedule = schedule;
    if (humanParticipation !== undefined) config.humanParticipation = humanParticipation;
    await AgentEnsembleService.updateConfig(podId, config);
    const updatedPod = await Pod.findById(podId) as { agentEnsemble?: unknown };
    return res.json({ success: true, message: 'Configuration updated', config: updatedPod?.agentEnsemble });
  } catch (error) {
    console.error('Failed to update ensemble config:', error);
    return res.status(400).json({ error: (error as Error).message });
  }
});

router.get('/:podId/ensemble/history', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { limit = '10' } = req.query || {};
    const pod = await checkEnsemblePod(podId || '');
    if (!pod) return res.status(404).json({ error: 'Pod not found' });
    if (pod.type !== 'agent-ensemble') return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    if (!pod.includes?.(req.user?.id || '')) return res.status(403).json({ error: 'Not a member of this pod' });
    // eslint-disable-next-line global-require
    const AgentEnsembleState = require('../models/AgentEnsembleState');
    const history = await AgentEnsembleState.find({ podId, status: 'completed' }).sort({ 'stats.completedAt': -1 }).limit(parseInt(limit, 10)).select('topic participants stats summary createdAt').lean();
    return res.json({ success: true, history });
  } catch (error) {
    console.error('Failed to get ensemble history:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
});

router.post('/:podId/ensemble/response', agentRuntimeAuth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const { ensembleId, agentType, instanceId, content, messageId } = (req.body || {}) as { ensembleId?: string; agentType?: string; instanceId?: string; content?: string; messageId?: string };
    const authAgentType = req.agentUser?.botMetadata?.agentName || req.agentInstallation?.agentName;
    const authInstanceId = req.agentUser?.botMetadata?.instanceId || req.agentInstallation?.instanceId || 'default';
    if (authAgentType !== agentType || authInstanceId !== (instanceId || 'default')) {
      return res.status(403).json({ error: 'Agent identity mismatch', expected: `${authAgentType}:${authInstanceId}`, received: `${agentType}:${instanceId || 'default'}` });
    }
    const state = await AgentEnsembleService.processAgentResponse(ensembleId, { agentType, instanceId: instanceId || 'default', content, messageId }) as { turnState?: { currentAgent?: string; turnNumber?: number } };
    res.json({ success: true, nextAgent: state.turnState?.currentAgent, turnNumber: state.turnState?.turnNumber });
  } catch (error) {
    console.error('[ensemble] Response error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

module.exports = router;

export {};
