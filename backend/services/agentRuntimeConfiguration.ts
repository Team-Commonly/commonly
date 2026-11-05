import { Request, Response } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import AgentCredential from '../models/AgentCredential';
import { ownsRuntimeIdentity } from './runtimeIdentityOwnership';
import { isSpawnCredential } from './spawnCredentialService';
import { KERNEL_RUN_RUNTIME_TYPES, storedRuntimeType } from './configWriteGuard';
import { runtimeControlRefusal } from './runtimeControlValidation';

const SETTINGS_POINTER = "Change the model in the agent's Settings, then Model.";

// F178: the seat key a daemon minted for a machine-bound agent. Auth has already
// checked that the key is live, that its issuer is live and that the machine is
// still its owner's. Here: the key is a seat root (not a per-turn spawn child),
// it was issued by THIS machine's daemon for THIS owner, and the identity it
// authenticates is bound to the same machine.
const isMachineSeatKey = async (req: Request): Promise<boolean> => {
  const credential = req.agentCredential;
  const machineId = credential?.machineId;
  if (!machineId || !credential?.parentId || req.agentUser?.botMetadata?.machineId !== machineId) return false;
  return Boolean(await AgentCredential.exists({ _id: credential.parentId, kind: 'daemon', status: 'active',
    machineId, ownerUserId: credential.ownerUserId }));
};

// A seat's own root key may change only that seat's BYO model controls: the
// page-issued key of a listener, or (F178) the daemon-minted key of a
// machine-bound seat. Either way it never becomes human auth, nor authority over
// MCP, sandbox, adapter or machine config. Changing its own model on its owner's
// provider is no more than the owner's Settings page already lets them do, and
// the same machine-inventory check applies.
export const patchAgentRuntimeConfiguration = async (req: Request, res: Response): Promise<Response> => {
  const credential = req.agentCredential;
  if (!credential?.ownerUserId || isSpawnCredential(credential)) {
    return res.status(403).json({ message: `This key can't change the agent's model. ${SETTINGS_POINTER}` });
  }
  const machineSeat = Boolean(credential.machineId || credential.parentId || req.agentUser?.botMetadata?.machineId);
  if (machineSeat && !(await isMachineSeatKey(req))) {
    return res.status(403).json({ message: `This key can't change the agent's model. ${SETTINGS_POINTER}` });
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['agentName', 'instanceId', 'model', 'effort'].includes(key))
    || (body.model === undefined && body.effort === undefined)
    || (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 256))
    || (body.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort))) {
    return res.status(400).json({ message: 'Provide only agentName, instanceId and model and/or effort' });
  }
  const installation = req.agentInstallation;
  if (!installation || body.agentName !== installation.agentName
    || body.instanceId !== (installation.instanceId || 'default')) {
    return res.status(403).json({ message: 'Key does not belong to this agent identity' });
  }
  const { agentName } = installation;
  const instanceId = installation.instanceId || 'default';
  if (!(await ownsRuntimeIdentity(credential.ownerUserId, agentName, instanceId)).owned) {
    return res.status(403).json({ message: 'Key owner must be the sole installer' });
  }
  const rows = await AgentInstallation.find({
    agentName, instanceId, status: 'active', installedBy: credential.ownerUserId,
    'config.runtime.host': 'byo',
  }).sort({ createdAt: 1, _id: 1 }).select('_id podId config.runtime').lean();
  if (!rows.length) return res.status(403).json({ message: 'No owned BYO installation found' });
  if (rows.some((row) => KERNEL_RUN_RUNTIME_TYPES.has(storedRuntimeType(row.config)))) {
    return res.status(403).json({ message: 'Hosted model controls require an owner login' });
  }
  if (machineSeat) {
    const refusal = await runtimeControlRefusal({ agentName, instanceId, ownerUserId: String(credential.ownerUserId),
      config: { environment: { model: body.model, effort: body.effort } },
      effectiveHarness: (rows[0].config as { runtime?: { adapter?: string } } | undefined)?.runtime?.adapter });
    if (refusal) return res.status(422).json({ code: 'unsupported_runtime_control', message: refusal });
  }
  const updates: Record<string, string> = {};
  for (const key of ['model', 'effort']) {
    if (body[key] !== undefined) {
      updates[`config.environment.${key}`] = body[key];
      updates[`config.runtime.${key}`] = body[key];
    }
  }
  // Dot updates preserve all existing declarations. Updating every projection
  // of this owned identity keeps the server's selected source consistent.
  await AgentInstallation.updateMany({
    _id: { $in: rows.map((row) => row._id) }, agentName, instanceId,
    status: 'active', installedBy: credential.ownerUserId, 'config.runtime.host': 'byo',
  }, { $set: updates });
  return res.json({ podId: String(rows[0].podId) });
};
