import { normalizeRuntimeInventory, HarnessInventory } from './runtimeInventory';
import crypto from 'crypto';
import { Types } from 'mongoose';
import Machine, { IMachine, IMachineAgentState } from '../models/Machine';
import AgentCredential from '../models/AgentCredential';
import User from '../models/User';
import { issueDaemonCredential } from './daemonCredentialService';

// A daemon reports regularly; read paths derive offline from the last report
// rather than writing stale state merely because somebody opened the page.
export const MACHINE_OFFLINE_AFTER_MS = 90_000;
export const MAX_MACHINES_PER_OWNER = 20;

export interface MachineView {
  id: string;
  machineId: string;
  name: string;
  lastSeenAt: Date | null;
  status: 'online' | 'offline';
  agentStates: IMachineAgentState[];
  runtimeInventory: HarnessInventory[];
  inventoryAt: Date | null;
}

// D5 heartbeat payload bounds. A daemon reports every agent it supervises;
// anything beyond the machine-level cap is a malfunctioning reporter, not a
// bigger fleet — drop the tail rather than storing unbounded caller input.
export const MAX_REPORTED_AGENT_STATES = 100;
const AGENT_RUN_STATES = new Set(['running', 'stopped', 'crashed']);

export function normalizeAgentStates(raw: unknown): IMachineAgentState[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_REPORTED_AGENT_STATES)
    .map((entry) => {
      const e = (entry || {}) as Record<string, unknown>;
      const agentName = String(e.agentName || '').trim().toLowerCase();
      const state = String(e.state || '');
      if (!agentName || !AGENT_RUN_STATES.has(state)) return null;
      const restarts = Number(e.restarts);
      return {
        agentName,
        instanceId: String(e.instanceId || '').trim().toLowerCase() || 'default',
        state: state as IMachineAgentState['state'],
        restarts: Number.isFinite(restarts) && restarts > 0 ? Math.floor(restarts) : 0,
      };
    })
    .filter((entry): entry is IMachineAgentState => entry !== null);
}

export interface MachineListView {
  machines: MachineView[];
  offlineAfterMs: number;
}

const asId = (value: unknown): string => String(value || '');

// `create()`/`findById()` return an IMachine document while `lean()` returns
// a plain record. Keep the serializer honest about both shapes rather than
// pretending documents have a string index signature.
type LeanMachine = Record<string, unknown>;
const serializeMachine = (machine: IMachine | LeanMachine, now = new Date()): MachineView => {
  const lastSeenAt = machine.lastSeenAt ? new Date(machine.lastSeenAt as string | Date) : null;
  return {
    id: asId(machine._id),
    machineId: String(machine.machineId),
    name: String(machine.name),
    lastSeenAt,
    status: lastSeenAt && now.getTime() - lastSeenAt.getTime() <= MACHINE_OFFLINE_AFTER_MS
      ? 'online'
      : 'offline',
    runtimeInventory: normalizeRuntimeInventory(machine.runtimeInventory) || [],
    inventoryAt: machine.inventoryAt ? new Date(machine.inventoryAt as string | Date) : null,
    agentStates: ((machine.agentStates || []) as IMachineAgentState[]).map((s) => ({
      agentName: s.agentName,
      instanceId: s.instanceId,
      state: s.state,
      restarts: s.restarts,
    })),
  };
};

export async function registerMachine({
  ownerUserId,
  name,
  deviceTokenHash,
}: {
  ownerUserId: Types.ObjectId | string;
  name: unknown;
  deviceTokenHash?: string;
}): Promise<{ machine: MachineView; token: string }> {
  const normalizedName = String(name || '').trim();
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error('Machine name must be between 1 and 120 characters');
  }

  const count = await Machine.countDocuments({ ownerUserId });
  if (count >= MAX_MACHINES_PER_OWNER) {
    throw new Error(`Machine limit of ${MAX_MACHINES_PER_OWNER} reached`);
  }

  const machine = await Machine.create({
    ownerUserId,
    machineId: crypto.randomUUID(),
    name: normalizedName,
    // Explicit null distinguishes a new browser/API-token registration from
    // pre-binding rows, whose missing field cannot be attributed to a device.
    registeredByDeviceTokenHash: deviceTokenHash || null,
    status: 'offline',
  });

  try {
    const { token, credential } = await issueDaemonCredential({
      ownerUserId,
      machineId: machine.machineId,
      name: machine.name,
    });
    const machineStillPresent = await Machine.exists({
      _id: machine._id, machineId: machine.machineId, ownerUserId,
    });
    if (!machineStillPresent) {
      await AgentCredential.revokeCascade(credential._id);
      throw new Error('Machine removed during registration');
    }
    if (deviceTokenHash) {
      // A revoke racing registration must not leave a new daemon alive after
      // the revoke's machine scan has passed.
      const deviceStillActive = await User.exists({
        _id: ownerUserId,
        deviceTokens: { $elemMatch: { tokenHash: deviceTokenHash, revokedAt: { $in: [null] } } },
      });
      if (!deviceStillActive) {
        await removeMachine({ machineDbId: String(machine._id), actorUserId: String(ownerUserId), isAdmin: false });
        throw new Error('Device token revoked during machine registration');
      }
    }
    return { machine: serializeMachine(machine.toObject ? machine.toObject() : machine), token };
  } catch (error) {
    // Do not return a machine whose daemon credential failed to mint. The
    // cleanup is safe to retry and no bearer value escaped this function.
    await Machine.deleteOne({ _id: machine._id });
    throw error;
  }
}

export async function listMachinesForOwner(ownerUserId: Types.ObjectId | string): Promise<MachineListView> {
  const machines = await Machine.find({ ownerUserId }).sort({ lastSeenAt: -1 }).lean();
  const now = new Date();
  return {
    machines: machines.map((machine: Record<string, unknown>) => serializeMachine(machine, now)),
    offlineAfterMs: MACHINE_OFFLINE_AFTER_MS,
  };
}

// The daemon's status call has no need to enumerate its owner's machines.
// Match both credential-derived identifiers and return the same derived view
// the owner list uses, never the credential-bearing document.
export async function getMachineForDaemon({
  machineId,
  ownerUserId,
}: {
  machineId: string;
  ownerUserId: Types.ObjectId | string;
}): Promise<MachineView | null> {
  const machine = await Machine.findOne({ machineId, ownerUserId }).lean();
  return machine ? serializeMachine(machine) : null;
}

// A failed cleanup must not turn a durable device revoke into a live daemon.
// New browser/API registrations carry explicit null; missing fields are
// pre-binding rows and are conservatively denied after any device revoke.
export async function machineHasLiveAuthorization(
  machineId: string,
  ownerUserId: Types.ObjectId | string,
): Promise<boolean> {
  const machine = await Machine.findOne({ machineId, ownerUserId })
    .select('registeredByDeviceTokenHash').lean();
  if (!machine) return false;
  if (machine.registeredByDeviceTokenHash === null) return true;
  if (machine.registeredByDeviceTokenHash) {
    return Boolean(await User.exists({
      _id: ownerUserId,
      deviceTokens: { $elemMatch: {
        tokenHash: machine.registeredByDeviceTokenHash,
        revokedAt: { $in: [null] },
      } },
    }));
  }
  return !await User.exists({
    _id: ownerUserId,
    deviceTokens: { $elemMatch: { revokedAt: { $ne: null } } },
  });
}

export async function recordMachineHeartbeat(
  machine: IMachine,
  agentStates?: unknown,
  runtimeInventory?: unknown,
): Promise<MachineView> {
  machine.lastSeenAt = new Date();
  machine.status = 'online';
  // A heartbeat WITHOUT an agents array leaves the last report standing (a
  // Phase-1 daemon keeps working); one WITH the array replaces it wholesale.
  const normalized = normalizeAgentStates(agentStates);
  if (normalized !== null) machine.agentStates = normalized;
  const inventory = normalizeRuntimeInventory(runtimeInventory);
  if (inventory !== null) { machine.runtimeInventory = inventory; machine.inventoryAt = new Date(); }
  await machine.save();
  return serializeMachine(machine.toObject ? machine.toObject() : machine);
}

export async function removeMachine({
  machineDbId,
  actorUserId,
  isAdmin,
}: {
  machineDbId: string;
  actorUserId: string;
  isAdmin: boolean;
}): Promise<'removed' | 'not_found' | 'forbidden'> {
  const machine = await Machine.findById(machineDbId);
  if (!machine) return 'not_found';
  if (!isAdmin && String(machine.ownerUserId) !== actorUserId) return 'forbidden';

  const credentials = await AgentCredential.find({ machineId: machine.machineId }).select('_id').lean();
  // Include all machine-bound roots, not only daemon rows: a seat minted on
  // this machine can have a spawn child without a daemon parent. One breadth-
  // first walk also keeps a busy machine's removal bounded by lineage depth.
  await AgentCredential.revokeCascade(credentials.map((credential) => credential._id));

  // S2 owns the identity-level CAS. Deletion clears the binding but preserves
  // the agent User row, identity, and memory.
  await User.updateMany(
    { 'botMetadata.machineId': machine.machineId },
    { $set: { 'botMetadata.machineId': null } },
    { strict: false },
  );
  await Machine.deleteOne({ _id: machine._id });
  // A registration already past its initial machine insert can issue a daemon
  // credential between the first scan and deletion. Its own post-issue check
  // catches inserts after deletion; this second pass catches inserts before.
  const lateCredentials = await AgentCredential.find({ machineId: machine.machineId }).select('_id').lean();
  await AgentCredential.revokeCascade(lateCredentials.map((credential) => credential._id));
  return 'removed';
}

// Device-login tokens and daemon tokens are different bearers. Revoking the
// former must retire every machine it registered. For pre-binding machine
// rows, ownership is the only durable link: retire those too, rather than
// leave an older daemon live after its owner's device was revoked.
export async function removeMachinesForDeviceToken(ownerUserId: string, deviceTokenHash: string): Promise<void> {
  const machines = await Machine.find({
    ownerUserId,
    $or: [
      { registeredByDeviceTokenHash: deviceTokenHash },
      { registeredByDeviceTokenHash: { $exists: false } },
    ],
  }).select('_id').lean();
  for (const machine of machines) {
    // eslint-disable-next-line no-await-in-loop
    await removeMachine({ machineDbId: String(machine._id), actorUserId: ownerUserId, isAdmin: false });
  }
}

module.exports = {
  MACHINE_OFFLINE_AFTER_MS,
  MAX_MACHINES_PER_OWNER,
  MAX_REPORTED_AGENT_STATES,
  normalizeAgentStates,
  listMachinesForOwner,
  getMachineForDaemon,
  machineHasLiveAuthorization,
  recordMachineHeartbeat,
  registerMachine,
  removeMachine,
  removeMachinesForDeviceToken,
};
Object.assign(module.exports, exports);
