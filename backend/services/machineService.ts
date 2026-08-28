import crypto from 'crypto';
import { Types } from 'mongoose';
import Machine, { IMachine } from '../models/Machine';
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
}

export interface MachineListView {
  machines: MachineView[];
  offlineAfterMs: number;
}

const asId = (value: unknown): string => String(value || '');

const serializeMachine = (machine: Record<string, unknown>, now = new Date()): MachineView => {
  const lastSeenAt = machine.lastSeenAt ? new Date(machine.lastSeenAt as string | Date) : null;
  return {
    id: asId(machine._id),
    machineId: String(machine.machineId),
    name: String(machine.name),
    lastSeenAt,
    status: lastSeenAt && now.getTime() - lastSeenAt.getTime() <= MACHINE_OFFLINE_AFTER_MS
      ? 'online'
      : 'offline',
  };
};

export async function registerMachine({
  ownerUserId,
  name,
}: {
  ownerUserId: Types.ObjectId | string;
  name: unknown;
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
    status: 'offline',
  });

  try {
    const { token } = await issueDaemonCredential({
      ownerUserId,
      machineId: machine.machineId,
      name: machine.name,
    });
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

export async function recordMachineHeartbeat(machine: IMachine): Promise<MachineView> {
  machine.lastSeenAt = new Date();
  machine.status = 'online';
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

  const credentials = await AgentCredential.find({
    kind: 'daemon',
    machineId: machine.machineId,
  }).select('_id').lean();
  for (const credential of credentials) {
    // A cascade revokes every runtime child minted by this daemon before the
    // machine can be deleted, including a child that is otherwise still live.
    // eslint-disable-next-line no-await-in-loop
    await AgentCredential.revokeCascade(credential._id);
  }

  // S2 owns the identity-level CAS. Deletion clears the binding but preserves
  // the agent User row, identity, and memory.
  await User.updateMany(
    { 'botMetadata.machineId': machine.machineId },
    { $set: { 'botMetadata.machineId': null } },
    { strict: false },
  );
  await Machine.deleteOne({ _id: machine._id });
  return 'removed';
}

module.exports = {
  MACHINE_OFFLINE_AFTER_MS,
  MAX_MACHINES_PER_OWNER,
  listMachinesForOwner,
  recordMachineHeartbeat,
  registerMachine,
  removeMachine,
};
Object.assign(module.exports, exports);
