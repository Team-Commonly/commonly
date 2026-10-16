import mongoose, { Types } from 'mongoose';
import AgentFirstContact from '../models/AgentFirstContact';
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
}

interface RawUpsertResult {
  value?: unknown;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
}

const FIRST_CONTACT_CUE =
  'A human just added you to this workspace and is seeing you for the first time. '
  + 'This is your one first impression. Do NOT list your capabilities. Post a SHORT, '
  + 'warm greeting that ends with exactly ONE specific, answerable question that invites '
  + 'them to reply — something that gets them talking about what they want help with. '
  + 'One question mark, at the end.';

// The greeting's question invites a reply, and an agent that sees only its
// mentions would never see a plain one. So that greeting says how to reach it.
const mentionLineCue = (handle: string): string => (
  ` After the question, add one more line, exactly: "(Mention me as @${handle} so I see your answer.)" `
  + 'You only see messages that mention you, so without that line their answer would never reach you.'
);
const MENTION_HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Enqueue onboarding exactly once for the lifetime of a human/agent-identity
 * relationship. AgentFirstContact, rather than AgentInstallation, owns the
 * idempotency marker because installation rows can be recreated after an
 * uninstall. Resolves true only when this call enqueued the greeting, so the
 * install route knows whether the agent is about to speak for itself.
 */
export async function maybeFireFirstContact({
  agentName,
  instanceId,
  podId,
  installedByUserId,
  installerIsAgent,
  mentionHandle,
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

  if (result?.lastErrorObject?.updatedExisting === true || result?.value != null) {
    return false;
  }

  const handle = String(mentionHandle || '').trim().toLowerCase();

  try {
    await AgentEventService.enqueue({
      agentName: safeAgentName,
      instanceId: safeInstanceId,
      podId: safePodId,
      type: 'first_contact',
      payload: {
        content: MENTION_HANDLE.test(handle) ? `${FIRST_CONTACT_CUE}${mentionLineCue(handle)}` : FIRST_CONTACT_CUE,
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
