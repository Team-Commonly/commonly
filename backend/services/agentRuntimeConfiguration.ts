import { Request, Response } from 'express';
import { AgentInstallation } from '../models/AgentRegistry';
import { ownsRuntimeIdentity } from './runtimeIdentityOwnership';
import { isSpawnCredential } from './spawnCredentialService';
import { KERNEL_RUN_RUNTIME_TYPES, storedRuntimeType } from './configWriteGuard';

// A page-issued root key may change only its own BYO model controls. It never
// becomes human auth, nor authority over MCP, sandbox, adapter or machine config.
export const patchAgentRuntimeConfiguration = async (req: Request, res: Response): Promise<Response> => {
  const credential = req.agentCredential;
  if (!credential?.ownerUserId || credential.parentId || credential.machineId
    || isSpawnCredential(credential) || req.agentUser?.botMetadata?.machineId) {
    return res.status(403).json({ message: 'A page-issued BYO root key is required' });
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
