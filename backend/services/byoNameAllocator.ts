import Pod from '../models/Pod';
import User from '../models/User';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');

/**
 * The one BYO name rule: `base`, or the first of `base-2`, `base-3`, … that no
 * active install holds in a private pod the caller belongs to. The connect
 * page's suggestion (GET /api/registry/agents/next-free-name) and the connect
 * card's proposal both call this, so the card names the agent the page will
 * land on. A second rule here would let the two disagree again (TASK-329).
 *
 * With `podId`, the caller's own webhook install in that pod whose agent never
 * got a key does not take its name. A BYO click installs, then issues the key;
 * if the key never arrived (the request failed, or the person left first),
 * suggesting "<name>-2" makes the next click mint a second install and orphans
 * the first. Only in the pod being installed into: elsewhere the name would
 * put the same identity into a second pod. No pod given, no exemption.
 */
export const nextFreeByoName = async (
  userId: unknown,
  base: string,
  { podId }: { podId?: string } = {},
): Promise<string> => {
  const pods = await Pod.find({
    members: userId,
    type: { $nin: ['agent-room', 'agent-dm', 'agent-admin'] },
    publicRead: { $ne: true },
  }).select('_id').lean();
  const installations = pods.length ? await AgentInstallation.find({
    podId: { $in: pods.map((pod: any) => pod._id) },
    status: 'active',
  }).select('agentName instanceId installedBy config runtimeTokens podId').lean() : [];
  const selectedPodId = podId ? String(podId) : '';
  const unissued = await Promise.all(installations.map(async (row: any) => {
    if (!selectedPodId || String(row.podId) !== selectedPodId) return false;
    if (String(row.installedBy) !== String(userId)) return false;
    if (row.config?.runtime?.runtimeType !== 'webhook') return false;
    if (row.runtimeTokens?.length) return false;
    const username = AgentIdentityService.buildAgentUsername(
      AgentIdentityService.resolveAgentType(row.agentName),
      row.instanceId || 'default',
    );
    const agentUser: any = await User.findOne({ username }).select('agentRuntimeTokens').lean();
    return !agentUser?.agentRuntimeTokens?.length;
  }));
  const taken = new Set(installations
    .filter((_row: any, index: number) => !unissued[index])
    .map((row: any) => String(row.agentName).toLowerCase()));
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
  }
  return name;
};
