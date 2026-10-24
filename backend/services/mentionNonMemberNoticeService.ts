// A sender can address only pod members. When a real handle names someone
// outside this pod, return sender-only feedback. Suggested pods must also have
// the sender as a member; another agent's private memberships stay private.
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentProfile = require('../models/AgentProfile');
// eslint-disable-next-line global-require
const { buildMentionMap } = require('./agentMentionService');

export interface MentionNotice {
  code: 'MENTION_NOT_IN_POD';
  handle: string;
  message: string;
  pods?: Array<{ id: string; name: string }>;
}

const mentionedHandles = (content: string): string[] => {
  const handles = new Set<string>();
  const regex = /@([a-z0-9_-]{2,})/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null && handles.size < 20) {
    handles.add(match[1].toLowerCase());
  }
  return [...handles];
};

const exactHandle = (handle: string): RegExp => new RegExp(`^${handle}$`, 'i');

export const findNonMemberMentionNotices = async (
  podId: string,
  content: string,
  senderUserId?: string,
): Promise<MentionNotice[]> => {
  const handles = mentionedHandles(content);
  if (handles.length === 0) return [];

  const [pod, users, installations, profiles] = await Promise.all([
    Pod.findById(podId).select('members').lean(),
    // Usernames retain their original case at write time. Mention parsing
    // lowercases them, so use the same anchored case-insensitive match as
    // human mention routing.
    User.find({ $or: handles.map((handle) => ({ username: exactHandle(handle) })) })
      .select('_id username isBot').lean(),
    // Display-name slugs and instance handles are routable in the pod, so
    // inspect the same active installation records rather than only names.
    AgentInstallation.find({ status: 'active' })
      .select('podId agentName instanceId displayName').lean(),
    AgentProfile.find({}).select('podId agentName instanceId name').lean(),
  ]);
  if (!pod) return [];

  const members = new Set((pod.members || []).map((id: unknown) => String(id)));
  const known = new Set<string>();
  const inPod = new Set<string>();
  const podsByHandle = new Map<string, Set<string>>();
  for (const user of users || []) {
    const handle = String(user.username || '').toLowerCase();
    known.add(handle);
    // A leftover bot membership cannot receive a wake without an active
    // installation. Human membership alone is sufficient for addressing.
    if (!user.isBot && members.has(String(user._id))) inPod.add(handle);
  }
  const installationsByPod = new Map<string, Array<Record<string, unknown>>>();
  for (const installation of installations || []) {
    const installationPodId = String(installation.podId);
    const list = installationsByPod.get(installationPodId) || [];
    list.push(installation);
    installationsByPod.set(installationPodId, list);
  }
  for (const [installationPodId, podInstallations] of installationsByPod) {
    const podProfiles = (profiles || []).filter(
      (profile: { podId: unknown }) => String(profile.podId) === installationPodId,
    );
    const { map } = buildMentionMap(podInstallations, podProfiles);
    for (const handle of map.keys()) {
      known.add(handle);
      if (!podsByHandle.has(handle)) podsByHandle.set(handle, new Set());
      podsByHandle.get(handle)!.add(installationPodId);
      if (installationPodId === String(podId)) inPod.add(handle);
    }
  }

  const missing = handles.filter((handle) => known.has(handle) && !inPod.has(handle));
  const candidatePodIds = [...new Set(missing.flatMap((handle) => [...(podsByHandle.get(handle) || [])]))];
  const visiblePods = senderUserId && candidatePodIds.length
    ? await Pod.find({ _id: { $in: candidatePodIds }, members: senderUserId })
      .select('_id name').sort({ name: 1, _id: 1 }).lean()
    : [];
  return missing.map((handle) => {
    const podIds = podsByHandle.get(handle);
    const pods = visiblePods.filter((item: { _id: unknown }) => podIds?.has(String(item._id)))
      .slice(0, 5).map((item: { _id: unknown; name?: string }) => ({
        id: String(item._id), name: String(item.name || 'Pod'),
      }));
    return {
      code: 'MENTION_NOT_IN_POD' as const,
      handle,
      message: pods.length
        ? `${handle} isn't in this pod. Ask in: ${pods.map((item: { name: string }) => item.name).join(', ')}.`
        : `${handle} isn't in this pod. Invite them, or ask in a pod they're in.`,
      ...(pods.length ? { pods } : {}),
    };
  });
};
