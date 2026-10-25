import Pod from '../../models/Pod';
import User from '../../models/User';
import { AgentInstallation } from '../../models/AgentRegistry';
import { selectLiveGrantsForIdentities } from '../grantBrokerProjectionService';
import { allToolDefinitions } from '../toolBrokerService';
import { outsiderGrantPodRefusal } from '../outsiderGrantPodEligibility';
import { runsInNarrowedProcess } from '../hostedEngine';
import { PlaybookError } from './definition';
import type { PlaybookContext, PlaybookMember } from './preflight';

/** Server-only context. Role bindings never supply membership, runtimes or capabilities. */
export const loadPlaybookContext = async (podId: string): Promise<PlaybookContext> => {
  const pod = await Pod.findById(podId).select('members').lean();
  if (!pod) throw new PlaybookError('pod_not_found', 'Pod not found', 404);
  const ids = Array.from(new Set((pod.members || []).map(String)));
  const [users, installations, grants, grantPodRefusal] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('username isBot botType botMetadata').lean(),
    AgentInstallation.find({ podId, status: 'active' }).select('agentName instanceId config').lean(),
    selectLiveGrantsForIdentities({ identityIds: ids, podIds: [podId] }),
    outsiderGrantPodRefusal({ kind: 'pod', id: podId }),
  ]);
  const members: PlaybookMember[] = users.map((user: any) => {
    const member: PlaybookMember = { userId: String(user._id), handle: user.username,
      kind: user.isBot || user.botType ? 'agent' : 'person' };
    if (member.kind === 'agent' && user.botType === 'agent') {
      const name = String(user.botMetadata?.agentName || '').toLowerCase();
      const instanceId = String(user.botMetadata?.instanceId || 'default');
      const matches = installations.filter((row: any) => row.agentName === name
        && String(row.instanceId || 'default') === instanceId);
      if (name && matches.length === 1) {
        member.agentName = name;
        member.instanceId = instanceId;
        member.runtime = runsInNarrowedProcess(matches[0]) ? 'native' : 'byo';
      }
    }
    return member;
  });
  const definitions = new Map(allToolDefinitions().map((tool) => [tool.name, tool.requiredWriteMode]));
  const tools: PlaybookContext['tools'] = [];
  for (const [identity, live] of grants) {
    for (const grant of live) {
      // A grant on a seat or another pod is not this pod's declared capability.
      if (grant.target.kind !== 'pod' || String(grant.target.id) !== podId) continue;
      for (const name of grant.tools || []) {
        const mode = typeof name === 'string' ? definitions.get(name) : undefined;
        if (typeof name !== 'string' || !mode) continue;
        if (mode !== 'read' && grant.writeMode !== mode && grant.writeMode !== 'write') continue;
        tools.push({ name, mode, audience: [identity] });
      }
    }
  }
  return { members, tools, grantPodRefusal };
};
