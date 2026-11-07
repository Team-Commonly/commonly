import mongoose, { Types } from 'mongoose';
import AgentFirstContact from '../models/AgentFirstContact';
import Message from '../models/pg/Message';
import Pod from '../models/Pod';
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
  value?: unknown;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
}

const FIRST_CONTACT_CUE =
  'Do NOT list your capabilities. Post a SHORT, '
  + 'warm greeting that ends with exactly ONE specific, answerable question that invites '
  + 'them to reply — something that gets them talking about what they want help with. '
  + 'One question mark, at the end.';

// Launch walk 2026-11-05: a seat attached hours after the person joined
// threaded its greeting under their join post, and it read as a late
// welcome. The greeting answers no message, so it says where it goes.
const TOP_LEVEL_CUE =
  ' Post it top-level in the pod: do not set threadRootId or replyToMessageId, and do not reply to any earlier message.';

// A team pod isn't meeting the agent the way a newcomer is. The D244 experts
// opened with "What would you most like to understand?" to people mid-work.
const TEAM_POD_CUE =
  'You were just added to a pod where people are already working. Post ONE short line saying you are '
  + 'here and what you are for. Do not welcome anyone, do not treat anyone as a visitor, and do not '
  + 'ask what they want: if they need you, they will mention you.';

// The greeting's question invites a reply, and an agent that sees only its
// mentions would never see a plain one. So that greeting says how to reach it.
const mentionLineCue = (handle: string): string => (
  ` End that same message, after the question, with one more line, exactly: "(Mention me as @${handle} `
  + 'so I see your answer.)" It is part of the greeting: post one message, not two. You only see '
  + 'messages that mention you, so without that line their answer would never reach you.'
);
const MENTION_HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOSTED_GREETING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LOW_SIGNAL_REPLY = /^(?:ok|okay|lgtm|yes|no|thanks|thank you|thx|hi|hey|hello)[.!?\s]*$/iu;

const hasLanguageSignal = (words: string): boolean => (
  /[\p{L}\p{N}]/u.test(words) && !LOW_SIGNAL_REPLY.test(words.trim())
);

// Bots don't count: a solo workspace holds its person and their agents.
const hasAnotherPerson = async (podId: Types.ObjectId, userId: Types.ObjectId): Promise<boolean> => {
  try {
    const pod = await Pod.findById(podId).select('members').lean() as { members?: unknown[] } | null;
    const others = (pod?.members || []).filter((member) => String(member) !== String(userId));
    return others.length > 0 && Boolean(await User.exists({ _id: { $in: others }, isBot: { $ne: true } }));
  } catch (error) {
    console.warn('[first-contact] pod members unavailable', (error as Error).message);
    return false;
  }
};

const greetingLanguage = async (userId: Types.ObjectId): Promise<string | null> => {
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
  const words = previousWords.find(hasLanguageSignal);
  if (words) {
    if (/[\u3040-\u30ff]/u.test(words)) return 'Japanese';
    if (/[\u4e00-\u9fff]/u.test(words)) {
      if (zone === 'Asia/Tokyo') return 'Japanese';
      return ['Asia/Taipei', 'Asia/Hong_Kong'].includes(zone) ? 'Traditional Chinese' : 'Chinese';
    }
    // A person's substantive words outrank timezone even when this small
    // detector cannot name their language. Short replies and emoji can defer
    // to earlier words; a Spanish sentence in Tokyo must not become Japanese.
    return null;
  }
  if (zone === 'Asia/Tokyo') return 'Japanese';
  if (['Asia/Taipei', 'Asia/Hong_Kong'].includes(zone)) return 'Traditional Chinese';
  if (['Asia/Shanghai', 'Asia/Chongqing'].includes(zone)) return 'Chinese';
  // No language claim is safer than calling every Latin or unknown script English.
  return null;
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
  const greetingClaimPath = `greetedAtByPod.${String(safePodId)}`;
  const now = new Date();

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
          ...(hostedAgentUserId ? { greetedAtByPod: { [String(safePodId)]: now } } : {}),
          createdAt: now,
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

    // A legacy relationship marker can predate a new hosted start by months.
    // Recent speech in this pod means the person already met this seat here.
    const hasVisibleGreeting = await Message.hasMessageByUserInPod(safePodId, hostedAgentUserId);
    if (hasVisibleGreeting) return false;
    const expiredBefore = new Date(now.getTime() - HOSTED_GREETING_WINDOW_MS);
    const podClaim = await AgentFirstContact.findOneAndUpdate(
      {
        userId: safeUserId, agentName: safeAgentName, instanceId: safeInstanceId,
        $or: [
          { [greetingClaimPath]: { $exists: false } },
          { [greetingClaimPath]: { $lt: expiredBefore } },
        ],
      },
      { $set: { [greetingClaimPath]: now } },
      { new: false, includeResultMetadata: true },
    ) as unknown as RawUpsertResult;
    if (!podClaim?.value) return false;
  }

  const handle = String(mentionHandle || '').trim().toLowerCase();

  try {
    const language = hostedAgentUserId ? await greetingLanguage(safeUserId) : null;
    const languageCue = hostedAgentUserId
      ? `${language ? ` Use the person's language for this greeting: ${language}.` : ''} `
        + 'Do not introduce yourself using a human name, including one inferred from your @handle. '
      : '';
    const opening = hostedAgentUserId
      ? 'A person just started you in this pod and has not seen you speak here recently. '
      : 'A human just added you to this workspace and is seeing you for the first time. '
        + 'This is your one first impression. ';
    const mentionCue = MENTION_HANDLE.test(handle) ? mentionLineCue(handle) : '';
    const greeting = !hostedAgentUserId && await hasAnotherPerson(safePodId, safeUserId)
      ? `${TEAM_POD_CUE}${TOP_LEVEL_CUE}`
      : `${opening}${FIRST_CONTACT_CUE}${TOP_LEVEL_CUE}${languageCue}${mentionCue}`;
    await AgentEventService.enqueue({
      agentName: safeAgentName,
      instanceId: safeInstanceId,
      podId: safePodId,
      type: 'first_contact',
      payload: {
        content: greeting,
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
