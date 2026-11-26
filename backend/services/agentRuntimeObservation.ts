import { Request, Response } from 'express';
import AgentRuntimeObservation, { RECENT_TURN_LIMIT, SPAWN_FAILURE_REASONS } from '../models/AgentRuntimeObservation';
import { machineRunnerContext } from './agentProviderKey';

import { WALKED_HARNESSES } from './runtimeInventory';
const scalar = (value: unknown, max = 256): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max
  && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export const recordRuntimeObservation = async (req: Request, res: Response): Promise<Response> => {
  const target = await machineRunnerContext(req);
  if (!target) return res.status(403).json({ code: 'machine_runner_required' });
  const machineId = target.bot.botMetadata!.machineId;
  const body = req.body;
  const fields = ['agentName', 'instanceId', 'event', 'harness', 'version', 'model', 'effort', 'outcome', 'reason', 'at',
    'podId'];
  if (!body || !['connected', 'spawn', 'settled'].includes(body.event)
    || Object.keys(body).some((key) => !fields.includes(key))
    || (body.at !== undefined && (typeof body.at !== 'string' || body.at.length > 40
      || !Number.isFinite(new Date(body.at).getTime())))
    || (body.outcome !== undefined && (body.event !== 'settled' || !['completed', 'failed'].includes(body.outcome)))
    || (body.reason !== undefined && (body.outcome !== 'failed'
      || !(SPAWN_FAILURE_REASONS as readonly string[]).includes(body.reason)))
    // F669: the pod a spawn ran for, an id and nothing else, on a spawn only.
    || (body.podId !== undefined && (body.event !== 'spawn' || typeof body.podId !== 'string'
      || !/^[a-f0-9]{24}$/i.test(body.podId)))
    || (body.event === 'spawn' && (!WALKED_HARNESSES.includes(body.harness)
      || ![body.version, body.model, body.effort].every((value) => value === null || scalar(value))))) {
    return res.status(400).json({ code: 'invalid_runner_observation' });
  }
  const now = new Date();
  const set: Record<string, unknown> = { machineId, lastSeenAt: now };
  if (body.event === 'connected') Object.assign(set, { connectedAt: now, turnRunning: false });
  if (body.event === 'spawn') Object.assign(set, {
    turnRunning: true, lastSpawnOutcome: null, lastSpawnFailure: null,
    lastSpawn: { harness: body.harness, version: body.version, model: body.model, effort: body.effort,
      at: body.at ? new Date(body.at) : now },
  });
  if (body.event === 'settled') Object.assign(set, { turnRunning: false, lastTurnAt: now,
    ...(body.outcome ? { lastSpawnOutcome: body.outcome, lastSpawnFailure: body.reason || null } : {}) });
  // Each spawn is one turn, counted at the server's clock (F669, agentTurnCountService).
  const turn = body.event === 'spawn'
    ? { $push: { recentTurns: { $each: [{ podId: body.podId || null, at: now }], $slice: -RECENT_TURN_LIMIT } } }
    : {};
  await AgentRuntimeObservation.updateOne({ agentUserId: target.bot._id }, {
    $set: set, ...(body.event === 'connected' ? {} : { $setOnInsert: { connectedAt: now } }), ...turn,
  }, { upsert: true });
  return res.json({ recorded: true });
};
