import express from 'express';
import mongoose from 'mongoose';
import AgentRun from '../models/AgentRun';
import ToolCall from '../models/ToolCall';

const auth = require('../middleware/auth');
const Pod = require('../models/Pod');
const DMService = require('../services/dmService');
const router = express.Router();

// Trace access follows today's pod access, never the original grant audience
// or the continued existence of the card. Public pod listing is insufficient.
router.get('/:podId/runs/:runId', auth, async (req, res) => {
  try {
    const { podId, runId } = req.params;
    if (!mongoose.isObjectIdOrHexString(podId) || !mongoose.isObjectIdOrHexString(runId)) {
      return res.status(404).json({ error: 'trace_not_found' });
    }
    const userId = (req as express.Request & { user?: { id: string }; userId?: string }).user?.id
      || (req as express.Request & { userId?: string }).userId;
    const pod = await Pod.findById(podId).select('members type').lean();
    if (!await DMService.canViewPod(userId, pod)) {
      return res.status(404).json({ error: 'trace_not_found' });
    }
    // Do not load content-bearing args, results or LLM text even transiently.
    const run = await AgentRun.findOne({ _id: runId, podId })
      .select([
        'agentName instanceId status trigger startedAt completedAt totalTokens errorKind',
        'traceTruncated omittedTurns omittedToolCalls',
        'turns.turnIndex turns.model turns.elapsedMs turns.promptTokens turns.completionTokens turns.totalTokens',
        'turns.toolCalls.name turns.toolCalls.elapsedMs turns.toolCalls.callId turns.toolCalls.outcome',
      ].join(' '))
      .lean();
    if (!run) return res.status(404).json({ error: 'trace_not_found' });
    const callIds = run.turns.flatMap((turn) => turn.toolCalls.flatMap((call) => (call.callId ? [call.callId] : [])));
    // A PG outage is an error, never an apparently empty successful audit.
    const trail = await ToolCall.listRunReferences(podId, callIds);
    const byId = new Map(trail.map((call) => [call.callId, call]));
    res.set('Cache-Control', 'no-store');
    return res.json({
      run: {
        id: String(run._id), podId, agentName: run.agentName, instanceId: run.instanceId,
        status: run.status, trigger: run.trigger, startedAt: run.startedAt,
        completedAt: run.completedAt, totalTokens: run.totalTokens, errorKind: run.errorKind,
        traceTruncated: Boolean(run.traceTruncated), omittedTurns: run.omittedTurns || 0,
        omittedToolCalls: run.omittedToolCalls || 0,
        turns: run.turns.map((turn) => ({
          turnIndex: turn.turnIndex, model: turn.model, elapsedMs: turn.elapsedMs,
          promptTokens: turn.promptTokens, completionTokens: turn.completionTokens, totalTokens: turn.totalTokens,
          toolCalls: turn.toolCalls.map((call) => ({
            name: call.name, elapsedMs: call.elapsedMs, callId: call.callId,
            outcome: call.callId ? byId.get(call.callId)?.outcome || 'unavailable' : call.outcome || 'recorded',
            trail: call.callId ? byId.get(call.callId) || null : undefined,
          })),
        })),
      },
      // A default, not a fabricated per-message expiry: Pro protection and
      // disk pressure can change message retention. Neither deletes this trace.
      retention: { cardDefaultDays: 30, traceExpiresAt: null },
    });
  } catch (error) {
    console.error('[run-trace] read failed:', (error as Error).message);
    return res.status(503).json({ error: 'trace_unavailable' });
  }
});

module.exports = router;
