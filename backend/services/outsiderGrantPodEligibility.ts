/** Eligibility for a pod that can receive outsider-writable connector text. */
import { AgentInstallation } from '../models/AgentRegistry';
import Integration from '../models/Integration';
import Pod from '../models/Pod';
import User from '../models/User';

export type OutsiderGrantRefusal = 'pod_required' | 'pod_not_private'
  | 'pod_joinable' | 'pod_bridged' | 'non_native_agent' | 'write_mode_unconfined';

export const outsiderGrantRefusalMessage = (reason: OutsiderGrantRefusal): string => ({
  pod_required: 'Outsider-writable connectors require a pod grant; use a separate pod.',
  pod_not_private: 'This pod is public. Use a separate private pod for this connector.',
  pod_joinable: 'This pod is joinable. Use a separate invite-only pod for this connector.',
  pod_bridged: 'This pod is bridged to an external channel. Use a separate unbridged pod for this connector.',
  non_native_agent: 'This pod has an agent outside the narrowed native runtime. Use a separate pod for this connector.',
  write_mode_unconfined: 'This grant permits unattended writes. Use write-with-confirm in a separate pod.',
}[reason]);

const configObject = (value: unknown): Record<string, unknown> => {
  if (value instanceof Map) return Object.fromEntries(value);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
};

/** Re-read at mint and on every broker list/call; no cached eligibility. */
export const outsiderGrantPodRefusal = async (
  target: { kind?: string; id?: unknown },
  writeMode?: unknown,
): Promise<OutsiderGrantRefusal | null> => {
  if (target.kind !== 'pod' || !target.id) return 'pod_required';
  if (writeMode === 'write') return 'write_mode_unconfined';
  const podId = String(target.id);
  const pod = await Pod.findById(podId).select('members publicRead joinPolicy').lean();
  if (!pod) return 'pod_required';
  if (pod.publicRead !== false) return 'pod_not_private';
  if (pod.joinPolicy !== 'invite-only') return 'pod_joinable';

  const bridges = await Integration.find({
    // Fail closed when a new channel type is added: only credential rows are
    // known not to relay pod content to an external audience.
    type: { $nin: ['hosted-mcp', 'github-app'] },
    revokedAt: null,
    $or: [{ podId }, { [`config.gates.${podId}.enabled`]: true }],
  }).select('type scope podId status isActive config.gates config.adminPause').lean();
  if (bridges.some((bridge: any) => bridge.status !== 'disconnected'
    && bridge.status !== 'error' && bridge.isActive !== false
    && !bridge.config?.adminPause
    && (String(bridge.podId) === podId || bridge.config?.gates?.[podId]?.enabled === true))) {
    return 'pod_bridged';
  }

  const memberIds = (pod.members || []).map(String);
  const users = await User.find({ _id: { $in: memberIds } })
    .select('isBot botType botMetadata.agentName botMetadata.instanceId').lean();
  // Missing member rows are unsafe: their agent/human type cannot be proven.
  if (users.length !== memberIds.length) return 'non_native_agent';
  const agents = users.filter((user: any) => user.isBot || user.botType);
  const installations = await AgentInstallation.find({ podId, status: 'active' })
    .select('agentName instanceId config').lean();
  const agentKeys = new Set(agents.map((agent: any) => (
    `${String(agent.botMetadata?.agentName || '').toLowerCase()}:${String(agent.botMetadata?.instanceId || 'default')}`
  )));
  for (const installation of installations) {
    const config = configObject(installation.config);
    const runtime = configObject(config.runtime);
    const key = `${installation.agentName}:${String(installation.instanceId || 'default')}`;
    if (runtime.runtimeType !== 'native' || !agentKeys.has(key)) return 'non_native_agent';
  }
  for (const agent of agents) {
    if (agent.botType !== 'agent') return 'non_native_agent';
    const name = String(agent.botMetadata?.agentName || '').toLowerCase();
    const instanceId = String(agent.botMetadata?.instanceId || 'default');
    const matching = installations.filter((row: any) => row.agentName === name
      && String(row.instanceId || 'default') === instanceId);
    if (!name || matching.length !== 1) return 'non_native_agent';
  }
  return null;
};
