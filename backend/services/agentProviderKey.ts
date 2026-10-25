import { Types } from 'mongoose';
import { Request, Response } from 'express';
import User from '../models/User';
import Machine from '../models/Machine';
import ConnectorSecret from '../models/ConnectorSecret';
import AgentProviderKey from '../models/AgentProviderKey';
import * as secrets from './connectorSecrets';
import { AGENT_PROVIDER_KEY } from './connectorSecretKinds';
import { projectSeatEnvironments, seatEnvironmentKey } from './seatEnvironmentProjection';
import { ownsRuntimeIdentity } from './runtimeIdentityOwnership';
import { effectiveSandboxTrust } from './grantBrokerConfinement';

export const ownKeyCapability = (runtime: any, environment: any) => {
  const harness = runtime?.adapter;
  const sandbox = environment?.sandbox;
  const provider = environment?.provider;
  let secureDestination = false;
  try {
    const url = new URL(provider?.baseURL);
    secureDestination = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { /* no explicit provider */ }
  // Lily's confined-modes-only ruling: the other harnesses' normal credential
  // paths expose their bearer to tool env/config. Do not offer them a setter.
  const available = runtime?.runtimeType === 'wrapper' && harness === 'opencode'
    && effectiveSandboxTrust(sandbox?.trust) === 'public'
    && ['workspace', 'read-only', 'bwrap'].includes(sandbox?.mode)
    && secureDestination && typeof provider?.id === 'string' && Boolean(provider.id.trim());
  return { available: Boolean(available), provider: available ? provider.id : null };
};
const metadata = (row: any) => ({ set: Boolean(row?.secretRef), setAt: row?.setAt || null,
  setBy: row?.setBy ? String(row.setBy) : null, lastUsedAt: row?.lastUsedAt || null });
const context = async (ownerUserId: string, agentName: string, instanceId: string) => {
  if (!(await ownsRuntimeIdentity(ownerUserId, agentName, instanceId)).owned) return null;
  const bot = await User.findOne({ isBot: true, 'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId }).select('botMetadata.machineId').lean();
  if (!bot?.botMetadata?.machineId
    || !(await Machine.exists({ machineId: bot.botMetadata.machineId, ownerUserId }))) return null;
  const seat = (await projectSeatEnvironments({ installedBy: ownerUserId, agentName }))
    .get(seatEnvironmentKey(agentName, instanceId));
  return seat ? { bot, seat, capability: ownKeyCapability(seat.runtime, seat.environment) } : null;
};

export const manageProviderKey = async (req: Request, res: Response): Promise<Response> => {
  res.set('Cache-Control', 'no-store');
  const owner = String((req as any).user?.id || '');
  const agentName = String(req.params.name).toLowerCase();
  const instanceId = String(req.query.instanceId || 'default').toLowerCase();
  const target = owner ? await context(owner, agentName, instanceId) : null;
  if (!target) return res.status(403).json({ code: 'owned_machine_identity_required' });
  const filter = { agentUserId: target.bot._id, ownerUserId: owner };
  let row = await AgentProviderKey.findOne(filter);
  if (req.method === 'GET') return res.json(metadata(row));
  if (req.method === 'DELETE') {
    if (row) {
      const removed = await AgentProviderKey.findOneAndUpdate(filter, {
        $inc: { generation: 1 }, $set: { secretRef: null, setAt: null, setBy: null, lastUsedAt: null },
      }, { new: false });
      // The atomic pre-image names exactly the removed generation. Each set
      // owns an immutable secret, so delayed cleanup cannot delete its successor.
      if (removed?.secretRef) await ConnectorSecret.deleteOne({ _id: removed.secretRef });
    }
    return res.json(metadata(null));
  }
  if (!target.capability.available) return res.status(422).json({ code: 'own_key_requires_confined_provider' });
  if (!req.body || Object.keys(req.body).some((key) => key !== 'key')
    || typeof req.body.key !== 'string' || !req.body.key.trim() || req.body.key.length > 8192
    || /[\r\n]/.test(req.body.key)) return res.status(400).json({ code: 'invalid_provider_key' });
  const provider = target.seat.environment?.provider as { id: string; baseURL: string };
  // A row owns its encrypted secret independently of installation projections.
  // A destination change requires an explicit new set, never reusing an old key.
  row = await AgentProviderKey.findOneAndUpdate(filter, {
    $inc: { generation: 1 }, $setOnInsert: { providerId: provider.id, baseURL: provider.baseURL },
  }, { upsert: true, new: true, setDefaultsOnInsert: true });
  const generation = row!.generation;
  const previousRef = row!.secretRef;
  // Immutable material per generation: overwriting the old secret before
  // committing its new destination would expose a new key under an old binding.
  const ref = await secrets.put(String(new Types.ObjectId()), AGENT_PROVIDER_KEY, req.body.key.trim(), generation);
  row = await AgentProviderKey.findOneAndUpdate({ ...filter, generation }, { $set: {
    secretRef: ref, providerId: provider.id, baseURL: provider.baseURL,
    setAt: new Date(), setBy: owner, lastUsedAt: null,
  } }, { new: true });
  if (!row) { await secrets.revoke(ref); return res.status(409).json({ code: 'provider_key_changed' }); }
  await secrets.revoke(previousRef || undefined);
  return res.json(metadata(row));
};

export const machineRunnerContext = async (req: Request) => {
  const machine = (req as any).machine;
  const agentName = req.body?.agentName;
  const instanceId = req.body?.instanceId || 'default';
  if (!machine || typeof agentName !== 'string' || typeof instanceId !== 'string') return null;
  const target = await context(machine.ownerUserId, agentName, instanceId);
  return target?.bot.botMetadata?.machineId === machine.machineId ? target : null;
};

export const launchProviderKey = async (req: Request, res: Response): Promise<Response> => {
  res.set('Cache-Control', 'no-store');
  const target = await machineRunnerContext(req);
  const machine = (req as any).machine;
  if (!target) return res.status(403).json({ code: 'machine_runner_required' });
  const row = await AgentProviderKey.findOne({ agentUserId: target.bot._id, ownerUserId: machine.ownerUserId });
  if (!row?.secretRef) return res.json({ set: false });
  const provider = target.seat.environment?.provider as { id?: string; baseURL?: string } | undefined;
  if (!target.capability.available || req.body?.harness !== 'opencode'
    || req.body?.providerId !== row.providerId || req.body?.baseURL !== row.baseURL
    || provider?.id !== row.providerId || provider?.baseURL !== row.baseURL) {
    return res.status(409).json({ code: 'own_key_provider_changed' });
  }
  if (req.body?.metadataOnly === true) return res.json({ set: true });
  const key = await secrets.get(row.secretRef);
  const used = await AgentProviderKey.updateOne({ _id: row._id, secretRef: row.secretRef, generation: row.generation },
    { $set: { lastUsedAt: new Date() } });
  if (!used.matchedCount) return res.status(409).json({ code: 'provider_key_changed' });
  // Only the authenticated machine daemon can resolve material. Seat bearers
  // can reach model children during mint fallback and are never sufficient.
  // No config/owner read or model-child credential can resolve the material.
  return res.json({ set: true, key });
};
