import mongoose, { Types } from 'mongoose';
import AgentFirstContact from '../models/AgentFirstContact';
import Message from '../models/pg/Message';
import User from '../models/User';
import AgentEventService from './agentEventService';

interface FirstContactOptions {
  agentName: string;
  instanceId: string;
  podId: string | Types.ObjectId;
  installedByUserId: string | Types.ObjectId;
  installerIsAgent: boolean;
  /**
   * For an agent that sees only messages that mention it (a hosted agent):
   * the handle its greeting tells the person to use. Without it, an answer
   * typed plainly under the greeting's question never reaches the agent.
   */
  mentionHandle?: string;
  /** Only hosted native seats can greet again in a pod with no visible history. */
  hostedAgentUserId?: string;
}

interface RawUpsertResult {
  value?: { greetedPodIds?: Types.ObjectId[] } | null;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
}

const FIRST_CONTACT_CUE =
  'Do NOT list your capabilities. Post a SHORT, '
  + 'warm greeting that ends with exactly ONE specific, answerable question that invites '
  + 'them to reply — something that gets them talking about what they want help with. '
  + 'One question mark, at the end.';

// The greeting's question invites a reply, and an agent that sees only its
// mentions would never see a plain one. So that greeting says how to reach it.
const mentionLineCue = (handle: string): string => (
  ` End that same message, after the question, with one more line, exactly: "(Mention me as @${handle} `
  + 'so I see your answer.)" It is part of the greeting: post one message, not two. You only see '
  + 'messages that mention you, so without that line their answer would never reach you.'
);
const MENTION_HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const greetingLanguage = async (userId: Types.ObjectId): Promise<string> => {
  let zone = '';
  try {
    const user = await User.findById(userId).select('timezone').lean() as { timezone?: string } | null;
    zone = String(user?.timezone || '');
  } catch (error) {
    console.warn('[first-contact] timezone unavailable', (error as Error).message);
  }
  let previousWords: string[] = [];
  try {
    previousWords = await Message.recentContentByUser(userId);
  } catch (error) {
    console.warn('[first-contact] language history unavailable', (error as Error).message);
  }
  for (const words of previousWords) {
    if (/[\u3040-\u30ff]/u.test(words)) return 'Japanese';
    if (/[\u4e00-\u9fff]/u.test(words)) {
      if (zone === 'Asia/Tokyo') return 'Japanese';
      return ['Asia/Taipei', 'Asia/Hong_Kong'].includes(zone) ? 'Traditional Chinese' : 'Chinese';
    }
    if (/[a-z]{3}/iu.test(words)) return 'English';
  }
  if (zone === 'Asia/Tokyo') return 'Japanese';
  if (['Asia/Taipei', 'Asia/Hong_Kong'].includes(zone)) return 'Traditional Chinese';
  if (['Asia/Shanghai', 'Asia/Chongqing'].includes(zone)) return 'Chinese';
  return 'English';
};

/**
 * Enqueue onboarding once for a human/agent relationship, or once in a new
 * hosted pod with no visible speech from that seat. AgentFirstContact owns
 * the durable marker because installation rows can be recreated after an
 * uninstall. Resolves true only when this call enqueued the greeting.
 */
export async function maybeFireFirstContact({
  agentName,
  instanceId,
  podId,
  installedByUserId,
  installerIsAgent,
  mentionHandle,
  hostedAgentUserId,
}: FirstContactOptions): Promise<boolean> {
  if (installerIsAgent) return false;

  const safeAgentName = String(agentName || '').trim().toLowerCase();
  if (!safeAgentName || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(safeAgentName)) {
    throw new Error('Invalid agentName for first contact');
  }

  if (!mongoose.Types.ObjectId.isValid(String(installedByUserId))) {
    throw new Error('Invalid installedByUserId for first contact');
  }
  if (!mongoose.Types.ObjectId.isValid(String(podId))) {
    throw new Error('Invalid podId for first contact');
  }

  const safeUserId = new mongoose.Types.ObjectId(String(installedByUserId));
  const safePodId = new mongoose.Types.ObjectId(String(podId));
  const safeInstanceId = String(instanceId || 'default').trim().toLowerCase() || 'default';

  let result: RawUpsertResult;
  try {
    result = await AgentFirstContact.findOneAndUpdate(
      { userId: safeUserId, agentName: safeAgentName, instanceId: safeInstanceId },
      {
        $setOnInsert: {
          userId: safeUserId,
          agentName: safeAgentName,
          instanceId: safeInstanceId,
          firstPodId: safePodId,
          ...(hostedAgentUserId ? { greetedPodIds: [safePodId] } : {}),
          createdAt: new Date(),
        },
      },
      {
        upsert: true,
        new: false,
        // Mongoose 7 replacement for deprecated rawResult: true. We need the
        // driver's updatedExisting flag to distinguish the winning insert.
        includeResultMetadata: true,
        setDefaultsOnInsert: true,
      },
    ) as unknown as RawUpsertResult;
  } catch (error) {
    // Two concurrent upserts can both miss before the unique index picks a
    // winner. The loser is an expected no-op, not an install error.
    if ((error as { code?: number })?.code === 11000) return false;
    throw error;
  }

  const alreadyMet = result?.lastErrorObject?.updatedExisting === true || result?.value != null;
  if (alreadyMet) {
    if (!hostedAgentUserId) return false;
    if (result.value?.greetedPodIds?.some((id) => String(id) === String(safePodId))) return false;

    // A legacy relationship marker can predate a new hosted start by months.
    // Recent speech in this pod means the person already met this seat here.
    const hasVisibleGreeting = await Message.hasMessageByUserInPod(safePodId, hostedAgentUserId);
    const podClaim = await AgentFirstContact.findOneAndUpdate(
      {
        userId: safeUserId, agentName: safeAgentName, instanceId: safeInstanceId,
        greetedPodIds: { $ne: safePodId },
      },
      { $addToSet: { greetedPodIds: safePodId } },
      { new: false, includeResultMetadata: true },
    ) as unknown as RawUpsertResult;
    if (!podClaim?.value || hasVisibleGreeting) return false;
  }

  const handle = String(mentionHandle || '').trim().toLowerCase();

  try {
    const languageCue = hostedAgentUserId
      ? ` Use the person's language for this greeting: ${await greetingLanguage(safeUserId)}. `
        + 'Do not introduce yourself using a human name, including one inferred from your @handle. '
      : '';
    const opening = hostedAgentUserId
      ? 'A person just started you in this pod and has not seen you speak here recently. '
      : 'A human just added you to this workspace and is seeing you for the first time. ';
    const mentionCue = MENTION_HANDLE.test(handle) ? mentionLineCue(handle) : '';
    await AgentEventService.enqueue({
      agentName: safeAgentName,
      instanceId: safeInstanceId,
      podId: safePodId,
      type: 'first_contact',
      payload: {
        content: `${opening}${FIRST_CONTACT_CUE}${languageCue}${mentionCue}`,
        userId: String(safeUserId),
        kind: 'first-contact',
      },
    });
  } catch (error) {
    // The durable marker already exists. Surface the lost best-effort event,
    // but never turn onboarding into an install failure.
    console.warn('[first-contact] event enqueue failed', {
      agent: safeAgentName,
      instance: safeInstanceId,
      pod: String(safePodId),
      error: (error as Error).message,
    });
    return false;
  }
  return true;
}

export default { maybeFireFirstContact };
