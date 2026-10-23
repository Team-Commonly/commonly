import Pod from '../models/Pod';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';

const id = (value: unknown): string => String(value || '');

export const isPrivateListenerEnvironment = (environment: unknown): boolean => (
  Boolean(environment && typeof environment === 'object'
    && (environment as any).sandbox?.trust === 'private')
);

const configOf = (installation: any): Record<string, any> => (
  installation.config instanceof Map
    ? Object.fromEntries(installation.config)
    : (installation.config || {})
);

/** A private listener may take instructions only from its owner. */
export const privateListenerPodAllowed = async (podId: unknown, ownerUserId: unknown): Promise<boolean> => {
  const pod = await Pod.findById(podId).select('createdBy members joinPolicy publicRead communityListed').lean();
  if (!pod || pod.joinPolicy !== 'invite-only' || pod.publicRead || pod.communityListed
      || id(pod.createdBy) !== id(ownerUserId)
      || !(pod.members || []).some((member) => id(member) === id(ownerUserId))) return false;
  const members = await User.find({ _id: { $in: pod.members } }).select('_id isBot botType').lean();
  // A missing member row has unknown authority. Refuse rather than assume bot.
  if (members.length !== new Set((pod.members || []).map(id)).size) return false;
  const humans = members.filter((member: any) => !member.isBot && !member.botType);
  return humans.length === 1 && id(humans[0]._id) === id(ownerUserId);
};

/** Re-evaluate the full identity, since its runtime and token span every installation. */
export const privateListenerIdentityAllowed = async (
  agentName: string, instanceId: string, ownerUserId: unknown, requirePrivate = false,
): Promise<boolean> => {
  const installations = await AgentInstallation.find({ agentName, instanceId, status: 'active' })
    .select('podId installedBy config').lean();
  if (!requirePrivate && !installations.some(
    (installation: any) => isPrivateListenerEnvironment(configOf(installation).environment),
  )) {
    return true;
  }
  if (!installations.length || installations.some(
    (installation: any) => id(installation.installedBy) !== id(ownerUserId),
  )) {
    return false;
  }
  for (const installation of installations) {
    // eslint-disable-next-line no-await-in-loop
    if (!await privateListenerPodAllowed(installation.podId, ownerUserId)) return false;
  }
  return true;
};

export const privateListenerConfigurationValid = (environment: unknown): boolean => {
  if (!isPrivateListenerEnvironment(environment)) return true;
  const spec = environment as any;
  const path = spec.workspace?.path;
  return spec.sandbox?.mode === undefined
    && typeof path === 'string'
    && (path.startsWith('/') || path.startsWith('~/'))
    && path.trim().length > 1;
};
