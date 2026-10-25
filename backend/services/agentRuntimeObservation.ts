import { Request, Response } from 'express';
import AgentRuntimeObservation from '../models/AgentRuntimeObservation';
import Machine from '../models/Machine';
import { isSpawnCredential } from './spawnCredentialService';

import { WALKED_HARNESSES } from './runtimeInventory';
const scalar = (value: unknown, max = 256): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max
  && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export const recordRuntimeObservation = async (req: Request, res: Response): Promise<Response> => {
  const credential = req.agentCredential;
  const machineId = req.agentUser?.botMetadata?.machineId;
  // The lifetime runner holds this bearer; its model/tool child gets a spawn
  // credential and cannot manufacture a receipt. Never trust a body identity.
  if (!credential || isSpawnCredential(credential) || !machineId
    || credential.machineId !== machineId || !credential.ownerUserId || !req.agentUser
    || !(await Machine.exists({ machineId, ownerUserId: credential.ownerUserId }))) {
    return res.status(403).json({ code: 'machine_runner_required' });
  }
  const body = req.body;
  const fields = ['event', 'harness', 'version', 'model', 'effort', 'outcome', 'at'];
  if (!body || !['connected', 'spawn', 'settled'].includes(body.event)
    || Object.keys(body).some((key) => !fields.includes(key))
    || (body.at !== undefined && (typeof body.at !== 'string' || body.at.length > 40
      || !Number.isFinite(new Date(body.at).getTime())))
    || (body.outcome !== undefined && (body.event !== 'settled' || !['completed', 'failed'].includes(body.outcome)))
    || (body.event === 'spawn' && (!WALKED_HARNESSES.includes(body.harness)
      || ![body.version, body.model, body.effort].every((value) => value === null || scalar(value))))) {
    return res.status(400).json({ code: 'invalid_runner_observation' });
  }
  const now = new Date();
  const set: Record<string, unknown> = { machineId, lastSeenAt: now };
  if (body.event === 'connected') Object.assign(set, { connectedAt: now, turnRunning: false });
  if (body.event === 'spawn') Object.assign(set, {
    turnRunning: true, lastSpawnOutcome: null,
    lastSpawn: { harness: body.harness, version: body.version, model: body.model, effort: body.effort,
      at: body.at ? new Date(body.at) : now },
  });
  if (body.event === 'settled') Object.assign(set, { turnRunning: false, lastTurnAt: now,
    ...(body.outcome ? { lastSpawnOutcome: body.outcome } : {}) });
  await AgentRuntimeObservation.updateOne({ agentUserId: req.agentUser._id }, {
    $set: set, ...(body.event === 'connected' ? {} : { $setOnInsert: { connectedAt: now } }),
  }, { upsert: true });
  return res.json({ recorded: true });
};
