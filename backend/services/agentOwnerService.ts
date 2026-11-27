/**
 * agentOwnerService: whose agent is this, in this pod (F655).
 *
 * An agent has up to two owner sources, and each counts only when it names a
 * person:
 *   1. the installer of its installation in this pod (`installedBy`), which is
 *      the only source for a marketplace agent, whose User row is shared;
 *   2. its identity's `botMetadata.ownerUserId`, set for a self-serve agent.
 * ADR-004 C1: `installedBy` can be the agent itself, which is not a person,
 * so it is dropped. When one name is shown, the installer comes first.
 *
 * Every reader of "whose agent" uses this one rule: the chat byline, the
 * board, and the owner stamped on an agent's message. Lookups never throw: a
 * failure answers nobody, and each caller keeps its old behaviour.
 */
import mongoose from 'mongoose';

// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

export interface AgentOwners {
  installedBy: string | null;
  ownerUserId: string | null;
}

type AgentLike = {
  _id?: unknown;
  username?: string;
  isBot?: boolean;
  botMetadata?: { agentName?: string; instanceId?: string; ownerUserId?: unknown } | null;
} | null | undefined;

const NOBODY: AgentOwners = Object.freeze({ installedBy: null, ownerUserId: null }) as AgentOwners;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const LIVE_INSTALL = { $ne: 'uninstalled' };

const idOf = (value: unknown): string => {
  const id = value == null ? '' : String((value as { _id?: unknown })?._id ?? value);
  return OBJECT_ID.test(id) ? id : '';
};

// The installation key an agent row answers to, as the other installer reads
// spell it (attentionItemService.lookupInstaller): the name and instance the
// caller declares come first, then the identity's own.
const installKey = (
  agent: AgentLike, declared: { agentName?: unknown; instanceId?: unknown } = {},
): { agentName: string; instanceId: string } | null => {
  if (!declared.agentName && !agent?.isBot) return null;
  const agentName = String(declared.agentName || agent?.botMetadata?.agentName || agent?.username || '').toLowerCase();
  if (!agentName) return null;
  return { agentName, instanceId: String(declared.instanceId || agent?.botMetadata?.instanceId || 'default') };
};

const peopleAmong = async (ids: string[]): Promise<Set<string>> => {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Set();
  const users = await User.find({ _id: { $in: wanted } }).select('_id isBot').lean() as Array<{
    _id: unknown; isBot?: boolean;
  }>;
  return new Set(users.filter((user) => !user.isBot).map((user) => String(user._id)));
};

/** Both owner sources of one agent in one pod, each null unless it names a person. */
export const resolveAgentOwners = async (input: {
  podId: unknown;
  agentUser?: AgentLike;
  agentUserId?: unknown;
  /** The installation key the caller declares, read before the identity's own. */
  agentName?: unknown;
  instanceId?: unknown;
}): Promise<AgentOwners> => {
  try {
    const podId = idOf(input.podId);
    let agent = input.agentUser;
    if (!agent && idOf(input.agentUserId)) {
      agent = await User.findById(idOf(input.agentUserId)).select('_id username isBot botMetadata').lean();
    }
    const key = installKey(agent, { agentName: input.agentName, instanceId: input.instanceId });
    if (!podId || !key) return { ...NOBODY };
    const installation = await AgentInstallation.findOne({
      podId, agentName: key.agentName, instanceId: key.instanceId, status: LIVE_INSTALL,
    }).select('installedBy').lean() as { installedBy?: unknown } | null;
    const installedBy = idOf(installation?.installedBy);
    const ownerUserId = idOf(agent?.botMetadata?.ownerUserId);
    const agentId = idOf(agent?._id);
    const people = await peopleAmong([installedBy, ownerUserId].filter((id) => id && id !== agentId));
    return {
      installedBy: people.has(installedBy) ? installedBy : null,
      ownerUserId: people.has(ownerUserId) ? ownerUserId : null,
    };
  } catch (error) {
    console.warn('[agent-owner] owner lookup failed; answering nobody:', (error as Error).message);
    return { ...NOBODY };
  }
};

/** The one owner a reader is shown: the installer, else ownerUserId. */
export const displayOwnerId = (owners: AgentOwners): string | null => owners.installedBy || owners.ownerUserId || null;

/** True when this person is either of the agent's owners. */
export const isOwner = (owners: AgentOwners, userId: unknown): boolean => {
  const id = idOf(userId);
  return Boolean(id) && (owners.installedBy === id || owners.ownerUserId === id);
};

/**
 * Both owners of every agent among a pod's members, in two reads: the pod's
 * live installations, then which candidate ids are people. Members that are
 * people, or agents with no human owner, are left out of the map.
 */
export const ownersForPod = async (podId: unknown, members: AgentLike[]): Promise<Map<string, AgentOwners>> => {
  const owners = new Map<string, AgentOwners>();
  try {
    const pod = idOf(podId);
    const agents = (members || []).filter((member) => installKey(member) && idOf(member?._id));
    if (!pod || !agents.length) return owners;
    const installs = await AgentInstallation.find({
      podId: new mongoose.Types.ObjectId(pod),
      agentName: { $in: [...new Set(agents.map((agent) => installKey(agent)!.agentName))] },
      status: LIVE_INSTALL,
    }).select('agentName instanceId installedBy').lean() as Array<{
      agentName: string; instanceId?: string; installedBy?: unknown;
    }>;
    const installerOf = new Map(installs.map((row) => [
      `${row.agentName}:${row.instanceId || 'default'}`, idOf(row.installedBy),
    ]));
    const candidates = agents.map((agent) => {
      const key = installKey(agent)!;
      return {
        agentId: idOf(agent?._id),
        installedBy: installerOf.get(`${key.agentName}:${key.instanceId}`) || '',
        ownerUserId: idOf(agent?.botMetadata?.ownerUserId),
      };
    });
    const people = await peopleAmong(candidates.flatMap((row) => [row.installedBy, row.ownerUserId]
      .filter((id) => id && id !== row.agentId)));
    const person = (id: string, agentId: string) => (id && id !== agentId && people.has(id) ? id : null);
    candidates.forEach((row) => {
      const found = { installedBy: person(row.installedBy, row.agentId), ownerUserId: person(row.ownerUserId, row.agentId) };
      if (found.installedBy || found.ownerUserId) owners.set(row.agentId, found);
    });
  } catch (error) {
    console.warn('[agent-owner] pod owner lookup failed; naming nobody:', (error as Error).message);
  }
  return owners;
};

/** The shown owner of every agent among a pod's members (ownersForPod, then displayOwnerId). */
export const displayOwnersForPod = async (podId: unknown, members: AgentLike[]): Promise<Map<string, string>> => {
  const shown = new Map<string, string>();
  (await ownersForPod(podId, members)).forEach((owners, agentId) => {
    const id = displayOwnerId(owners);
    if (id) shown.set(agentId, id);
  });
  return shown;
};

export default {
  resolveAgentOwners, displayOwnerId, isOwner, ownersForPod, displayOwnersForPod,
};

// CJS compat: let require() return the default export directly
module.exports = exports.default; Object.assign(module.exports, exports);
