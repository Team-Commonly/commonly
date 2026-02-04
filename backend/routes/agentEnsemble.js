const express = require('express');
const auth = require('../middleware/auth');
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const AgentEnsembleService = require('../services/agentEnsembleService');
const Pod = require('../models/Pod');
const User = require('../models/User');

const router = express.Router();

/**
 * Agent Ensemble Pod (AEP) Routes
 *
 * Manages multi-agent discussions with turn-based orchestration.
 */

/**
 * POST /api/pods/:podId/ensemble/start
 * Start a new agent ensemble discussion
 */
router.post('/:podId/ensemble/start', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { topic, participants, maxMessages, maxRounds, maxDurationMinutes } = req.body;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (!pod.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this pod' });
    }

    const state = await AgentEnsembleService.startDiscussion(podId, {
      topic,
      participants,
      maxMessages,
      maxRounds,
      maxDurationMinutes,
      createdBy: req.user.id,
    });

    return res.status(201).json({
      success: true,
      message: 'Discussion started',
      state: {
        id: state._id,
        status: state.status,
        topic: state.topic,
        participants: state.participants,
        turnState: state.turnState,
      },
    });
  } catch (error) {
    console.error('Failed to start ensemble discussion:', error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/pods/:podId/ensemble/pause
 * Pause an active discussion
 */
router.post('/:podId/ensemble/pause', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (!pod.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this pod' });
    }

    const state = await AgentEnsembleService.pauseDiscussion(podId);

    return res.json({
      success: true,
      message: 'Discussion paused',
      state: {
        id: state._id,
        status: state.status,
        pausedAt: state.stats.pausedAt,
        turnNumber: state.turnState.turnNumber,
      },
    });
  } catch (error) {
    console.error('Failed to pause ensemble discussion:', error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/pods/:podId/ensemble/resume
 * Resume a paused discussion
 */
router.post('/:podId/ensemble/resume', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (!pod.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this pod' });
    }

    const state = await AgentEnsembleService.resumeDiscussion(podId);

    return res.json({
      success: true,
      message: 'Discussion resumed',
      state: {
        id: state._id,
        status: state.status,
        turnNumber: state.turnState.turnNumber,
        currentAgent: state.turnState.currentAgent,
      },
    });
  } catch (error) {
    console.error('Failed to resume ensemble discussion:', error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/pods/:podId/ensemble/complete
 * Manually complete a discussion
 */
router.post('/:podId/ensemble/complete', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (!pod.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this pod' });
    }

    const completed = await AgentEnsembleService.completeActiveForPod(podId, 'manual');

    return res.json({
      success: true,
      message: 'Discussion completed',
      state: {
        id: completed._id,
        status: completed.status,
        completionReason: completed.stats.completionReason,
        totalMessages: completed.stats.totalMessages,
        summary: completed.summary,
      },
    });
  } catch (error) {
    console.error('Failed to complete ensemble discussion:', error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/pods/:podId/ensemble/state
 * Get current ensemble state for a pod
 */
router.get('/:podId/ensemble/state', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (!pod.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this pod' });
    }

    const state = await AgentEnsembleService.getState(podId);

    if (!state) {
      return res.json({
        success: true,
        state: null,
        podConfig: pod.agentEnsemble || {},
      });
    }

    return res.json({
      success: true,
      state: {
        id: state._id,
        status: state.status,
        topic: state.topic,
        participants: state.participants,
        turnState: state.turnState,
        stats: state.stats,
        stopConditions: state.stopConditions,
        keyPoints: state.keyPoints?.slice(-5),
        summary: state.summary,
      },
      podConfig: pod.agentEnsemble || {},
    });
  } catch (error) {
    console.error('Failed to get ensemble state:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/pods/:podId/ensemble/config
 * Update ensemble configuration
 */
router.patch('/:podId/ensemble/config', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const {
      enabled,
      topic,
      participants,
      stopConditions,
      schedule,
      humanParticipation,
    } = req.body;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (pod.createdBy.toString() !== req.user.id) {
      const user = await User.findById(req.user.id).select('role');
      if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Only pod creator or global admin can update config' });
      }
    }

    const config = {};
    if (enabled !== undefined) config.enabled = enabled;
    if (topic !== undefined) config.topic = topic;
    if (participants !== undefined) config.participants = participants;
    if (stopConditions !== undefined) config.stopConditions = stopConditions;
    if (schedule !== undefined) config.schedule = schedule;
    if (humanParticipation !== undefined) config.humanParticipation = humanParticipation;

    await AgentEnsembleService.updateConfig(podId, config);

    const updatedPod = await Pod.findById(podId);

    return res.json({
      success: true,
      message: 'Configuration updated',
      config: updatedPod.agentEnsemble,
    });
  } catch (error) {
    console.error('Failed to update ensemble config:', error);
    return res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/pods/:podId/ensemble/history
 * Get discussion history for a pod
 */
router.get('/:podId/ensemble/history', auth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { limit = 10 } = req.query;

    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    if (pod.type !== 'agent-ensemble') {
      return res.status(400).json({ error: 'Pod is not an agent ensemble' });
    }

    if (!pod.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'Not a member of this pod' });
    }

    const AgentEnsembleState = require('../models/AgentEnsembleState');
    const history = await AgentEnsembleState.find({
      podId,
      status: 'completed',
    })
      .sort({ 'stats.completedAt': -1 })
      .limit(parseInt(limit, 10))
      .select('topic participants stats summary createdAt')
      .lean();

    return res.json({
      success: true,
      history,
    });
  } catch (error) {
    console.error('Failed to get ensemble history:', error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/pods/:podId/ensemble/response
 * Called by agent bridges to report their response
 */
router.post('/:podId/ensemble/response', agentRuntimeAuth, async (req, res) => {
  try {
    const { podId } = req.params;
    const { ensembleId, agentType, instanceId, content, messageId } = req.body;

    // Verify agent identity matches authenticated agent
    const authAgentType =
      req.agentUser?.botMetadata?.agentName || req.agentInstallation?.agentName;
    const authInstanceId =
      req.agentUser?.botMetadata?.instanceId ||
      req.agentInstallation?.instanceId ||
      'default';

    if (authAgentType !== agentType || authInstanceId !== (instanceId || 'default')) {
      return res.status(403).json({
        error: 'Agent identity mismatch',
        expected: `${authAgentType}:${authInstanceId}`,
        received: `${agentType}:${instanceId || 'default'}`,
      });
    }

    // Process the response
    const state = await AgentEnsembleService.processAgentResponse(ensembleId, {
      agentType,
      instanceId: instanceId || 'default',
      content,
      messageId,
    });

    res.json({
      success: true,
      nextAgent: state.turnState.currentAgent,
      turnNumber: state.turnState.turnNumber,
    });
  } catch (error) {
    console.error('[ensemble] Response error:', error);
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
