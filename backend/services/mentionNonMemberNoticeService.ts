// A sender can address only pod members. When a real handle names someone
// outside this pod, return sender-only feedback without exposing where they are.
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');

export interface MentionNotice {
  code: 'MENTION_NOT_IN_POD';
  handle: string;
  message: string;
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

const slug = (value: string): string => value.toLowerCase().trim()
  .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

const exactHandle = (handle: string): RegExp => new RegExp(`^${handle}$`, 'i');

const agentHandles = (installation: Record<string, unknown>): string[] => {
  const name = String(installation.agentName || '').toLowerCase();
  const instance = String(installation.instanceId || 'default').toLowerCase();
  return [name, instance, `${name}-${instance}`, slug(String(installation.displayName || ''))].filter(Boolean);
};

export const findNonMemberMentionNotices = async (
  podId: string,
  content: string,
): Promise<MentionNotice[]> => {
  const handles = mentionedHandles(content);
  if (handles.length === 0) return [];

  const [pod, users, installations] = await Promise.all([
    Pod.findById(podId).select('members').lean(),
    // Usernames retain their original case at write time. Mention parsing
    // lowercases them, so use the same anchored case-insensitive match as
    // human mention routing.
    User.find({ $or: handles.map((handle) => ({ username: exactHandle(handle) })) })
      .select('_id username').lean(),
    // Display-name slugs and instance handles are routable in the pod, so
    // inspect the same active installation records rather than only names.
    AgentInstallation.find({ status: 'active' })
      .select('podId agentName instanceId displayName').lean(),
  ]);
  if (!pod) return [];

  const members = new Set((pod.members || []).map((id: unknown) => String(id)));
  const known = new Set<string>();
  const inPod = new Set<string>();
  for (const user of users || []) {
    const handle = String(user.username || '').toLowerCase();
    known.add(handle);
    if (members.has(String(user._id))) inPod.add(handle);
  }
  for (const installation of installations || []) {
    for (const handle of agentHandles(installation)) {
      known.add(handle);
      if (String(installation.podId) === String(podId)) inPod.add(handle);
    }
  }

  return handles.filter((handle) => known.has(handle) && !inPod.has(handle))
    .map((handle) => ({
      code: 'MENTION_NOT_IN_POD' as const,
      handle,
      message: `${handle} isn't in this pod. Invite them, or ask in a pod they're in.`,
    }));
};
