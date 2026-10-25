import { Types } from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';
import { podIsBridged } from './outsiderGrantPodEligibility';
import AgentIdentityService from './agentIdentityService';

/** Full-tool native sessions accept only their human operator and exact agent. */
export const operatorOnlyPodAllowed = async (
  podId: string, installations: any[], agentUser: any,
): Promise<boolean> => {
  if (!/^[a-f0-9]{24}$/i.test(podId) || !installations.length) return false;
  const first = installations[0];
  const owner = String(first.installedBy || '');
  const instanceId = first.instanceId || 'default';
  if (!/^[a-f0-9]{24}$/i.test(owner) || installations.some((row) => (
    String(row.installedBy || '') !== owner || row.agentName !== first.agentName
    || (row.instanceId || 'default') !== instanceId
  )) || !installations.some((row) => String(row.podId) === podId)) return false;
  const listener = await User.findOne({
    username: AgentIdentityService.buildAgentUsername(
      AgentIdentityService.resolveAgentType(first.agentName), instanceId,
    ),
    isBot: true,
  }).select('_id').lean();
  if (!listener || (agentUser && String(agentUser._id) !== String(listener._id))) return false;
  const human = await User.findById(owner).select('isBot botType').lean();
  if (!human || human.isBot || human.botType) return false;
  const pod = await Pod.findById(new Types.ObjectId(podId))
    .select('type createdBy members joinPolicy publicRead communityListed').lean();
  if (!pod || ['agent-dm', 'agent-room', 'agent-admin'].includes(pod.type)
    || pod.joinPolicy !== 'invite-only' || pod.publicRead !== false
    || pod.communityListed !== false || String(pod.createdBy) !== owner) return false;
  const members = (pod.members || []).map(String);
  if (!members.includes(owner) || !members.includes(String(listener._id))
    || members.some((member) => member !== owner && member !== String(listener._id))) return false;
  return !await podIsBridged(String(pod._id));
};
