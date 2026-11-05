import { normalizeRuntimeInventory, HarnessInventory } from './runtimeInventory';
import crypto from 'crypto';
import { Types } from 'mongoose';
import Machine, { IMachine, IMachineAgentState, IMachineHost } from '../models/Machine';
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
  // When the owner added this computer. Two computers can share a name, and
  // the pickers tell them apart by it.
  createdAt: Date | null;
  lastSeenAt: Date | null;
  status: 'online' | 'offline';
  agentStates: IMachineAgentState[];
  runtimeInventory: HarnessInventory[];
  inventoryAt: Date | null;
  // D245: this computer's daemon reported running agents without a sandbox.
  hostUnconfined: boolean;
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

// TASK-784 (D164): what a daemon says its computer runs. Every field is
// checked against a fixed shape, and anything else is dropped, so the row can
// only ever hold a platform name, a number, an arch name and a version: no
// hostname, path or user name, whatever a caller sends. The names are Node's
// own process.platform and process.arch values.
const HOST_PLATFORMS = new Set([
  'aix', 'android', 'cygwin', 'darwin', 'freebsd', 'haiku', 'linux', 'netbsd', 'openbsd', 'sunos', 'win32',
]);
const HOST_ARCHES = new Set([
  'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64',
]);
const CLI_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

/**
 * The host report a CLI sent, reduced to the four fields it may carry. Null
 * when it sent none (an older CLI) or nothing in it passes, so a report never
 * clears a good one with nulls.
 */
export function normalizeHostReport(raw: unknown): IMachineHost | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const host: IMachineHost = {
    platform: typeof r.platform === 'string' && HOST_PLATFORMS.has(r.platform) ? r.platform : null,
    osMajor: Number.isInteger(r.osMajor) && (r.osMajor as number) >= 0 && (r.osMajor as number) < 10_000
      ? r.osMajor as number : null,
    arch: typeof r.arch === 'string' && HOST_ARCHES.has(r.arch) ? r.arch : null,
    cliVersion: typeof r.cliVersion === 'string' && CLI_VERSION.test(r.cliVersion) ? r.cliVersion : null,
  };
  return Object.values(host).some((value) => value !== null) ? host : null;
}

/**
 * TASK-784: an agent bound to a machine acked an event a person was waiting
 * on (an @mention or a DM) with a posted reply. The machine's first such
 * answer is kept and never moved. Telemetry: a failure here never fails the
 * ack.
 */
export async function noteMachineAnswered(
  agentUser: { botMetadata?: { machineId?: unknown } } | null | undefined,
  event: { type?: unknown; delivery?: { outcome?: unknown } | null } | null | undefined,
): Promise<void> {
  try {
    const machineId = agentUser?.botMetadata?.machineId;
    if (typeof machineId !== 'string' || !machineId) return;
    // Required here, not at the top: machineService loads on the auth path, and
    // the unanswered-mention service pulls in the identity and pod-line services.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { PERSON_WAITING_EVENT_TYPES } = require('./unansweredMentionService') as {
      PERSON_WAITING_EVENT_TYPES: readonly string[];
    };
    if (!PERSON_WAITING_EVENT_TYPES.includes(String(event?.type || ''))) return;
    if (event?.delivery?.outcome !== 'posted') return;
    await Machine.updateOne({ machineId, firstAnswerAt: null }, { $set: { firstAnswerAt: new Date() } });
  } catch (err) {
    console.warn('[machine] first-answer stamp failed:', (err as Error).message);
  }
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
    createdAt: machine.createdAt ? new Date(machine.createdAt as string | Date) : null,
    lastSeenAt,
    status: lastSeenAt && now.getTime() - lastSeenAt.getTime() <= MACHINE_OFFLINE_AFTER_MS
      ? 'online'
      : 'offline',
    runtimeInventory: normalizeRuntimeInventory(machine.runtimeInventory) || [],
    inventoryAt: machine.inventoryAt ? new Date(machine.inventoryAt as string | Date) : null,
    hostUnconfined: (machine as { hostUnconfined?: unknown }).hostUnconfined === true,
    agentStates: ((machine.agentStates || []) as IMachineAgentState[]).map((s) => ({
      agentName: s.agentName,
      instanceId: s.instanceId,
      state: s.state,
      restarts: s.restarts,
    })),
  };
};

// The host and the time it was reported, or nothing for an older CLI.
const hostFields = (raw: unknown): { host?: IMachineHost; hostReportedAt?: Date } => {
  const host = normalizeHostReport(raw);
  return host ? { host, hostReportedAt: new Date() } : {};
};

export async function registerMachine({
  ownerUserId,
  name,
  deviceTokenHash,
  host,
}: {
  ownerUserId: Types.ObjectId | string;
  name: unknown;
  deviceTokenHash?: string;
  host?: unknown;
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
    ...hostFields(host),
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

// D245: what a daemon says about its host's confinement on each check-in.
// Both native-Windows values turn grant refusal on for the machine's seats:
// 'native-windows' (no OS sandbox; Codex runs on its own profiles) and
// 'unsandboxed-opted-in' (the user's --unsandboxed). 'default' turns it off.
// Anything else (an older daemon sends nothing) leaves the last report standing.
export const HOST_SANDBOX_REPORTS = {
  unconfined: ['unsandboxed-opted-in', 'native-windows'] as readonly string[],
  confined: 'default',
} as const;

export async function recordMachineHeartbeat(
  machine: IMachine,
  agentStates?: unknown,
  runtimeInventory?: unknown,
  hostSandbox?: unknown,
  hostReport?: unknown,
): Promise<MachineView> {
  machine.lastSeenAt = new Date();
  // TASK-784: a check-in with a host report replaces the last one; an older
  // daemon's check-in carries none and leaves it standing.
  const { host, hostReportedAt } = hostFields(hostReport);
  if (host) { machine.host = host; machine.hostReportedAt = hostReportedAt || new Date(); }
  machine.status = 'online';
  // A heartbeat WITHOUT an agents array leaves the last report standing (a
  // Phase-1 daemon keeps working); one WITH the array replaces it wholesale.
  const normalized = normalizeAgentStates(agentStates);
  if (normalized !== null) machine.agentStates = normalized;
  const inventory = normalizeRuntimeInventory(runtimeInventory);
  if (inventory !== null) { machine.runtimeInventory = inventory; machine.inventoryAt = new Date(); }
  if (typeof hostSandbox === 'string' && HOST_SANDBOX_REPORTS.unconfined.includes(hostSandbox)) machine.hostUnconfined = true;
  else if (hostSandbox === HOST_SANDBOX_REPORTS.confined) machine.hostUnconfined = false;
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

export interface MachinePlatformStats {
  total: number;
  // null is "not reported": a machine an older CLI registered and that has not
  // checked in from a newer one since.
  byPlatform: Array<{ platform: string | null; machines: number; answered: number }>;
  byCliVersion: Array<{ cliVersion: string | null; machines: number }>;
}

// Largest first, unreported last, then by name (newest version first).
const byCountThenName = <T extends { machines: number }>(key: (row: T) => string | null) => (a: T, b: T): number => {
  if (b.machines !== a.machines) return b.machines - a.machines;
  const ka = key(a);
  const kb = key(b);
  if (ka === null || kb === null) return ka === kb ? 0 : (ka === null ? 1 : -1);
  return kb.localeCompare(ka, 'en', { numeric: true });
};

/**
 * TASK-784 admin stats: machines by platform, with how many of them had an
 * agent answer a person, and machines by CLI version. Counts only, from the
 * machine rows; no owner, name or id leaves this function.
 */
export async function readMachinePlatformStats(): Promise<MachinePlatformStats> {
  const [platforms, versions] = await Promise.all([
    Machine.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$host.platform', null] },
          machines: { $sum: 1 },
          answered: { $sum: { $cond: [{ $ifNull: ['$firstAnswerAt', false] }, 1, 0] } },
        },
      },
    ]),
    Machine.aggregate([
      { $group: { _id: { $ifNull: ['$host.cliVersion', null] }, machines: { $sum: 1 } } },
    ]),
  ]) as [
    Array<{ _id: string | null; machines: number; answered: number }>,
    Array<{ _id: string | null; machines: number }>,
  ];
  const byPlatform = platforms
    .map((row) => ({ platform: row._id, machines: row.machines, answered: row.answered }))
    .sort(byCountThenName((row) => row.platform));
  const byCliVersion = versions
    .map((row) => ({ cliVersion: row._id, machines: row.machines }))
    .sort(byCountThenName((row) => row.cliVersion));
  return { total: byPlatform.reduce((sum, row) => sum + row.machines, 0), byPlatform, byCliVersion };
}
