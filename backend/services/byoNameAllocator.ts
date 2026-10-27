import Pod from '../models/Pod';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

/**
 * The one BYO name rule: `base`, or the first of `base-2`, `base-3`, … that no
 * active install holds in a private pod the caller belongs to. The connect
 * page's suggestion (GET /api/registry/agents/next-free-name) and the connect
 * card's proposal both call this, so the card names the agent the page will
 * land on. A second rule here would let the two disagree again (TASK-329).
 */
export const nextFreeByoName = async (userId: unknown, base: string): Promise<string> => {
  const pods = await Pod.find({
    members: userId,
    type: { $nin: ['agent-room', 'agent-dm', 'agent-admin'] },
    publicRead: { $ne: true },
  }).select('_id').lean();
  const installations = pods.length ? await AgentInstallation.find({
    podId: { $in: pods.map((pod: any) => pod._id) },
    status: 'active',
  }).select('agentName').lean() : [];
  const taken = new Set(installations.map((row: any) => String(row.agentName).toLowerCase()));
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
  }
  return name;
};
