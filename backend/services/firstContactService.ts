import mongoose, { Types } from 'mongoose';
import AgentFirstContact from '../models/AgentFirstContact';
import AgentEventService from './agentEventService';

interface FirstContactOptions {
  agentName: string;
  instanceId: string;
  podId: string | Types.ObjectId;
  installedByUserId: string | Types.ObjectId;
  installerIsAgent: boolean;
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

/**
 * Enqueue onboarding exactly once for the lifetime of a human/agent-identity
 * relationship. AgentFirstContact, rather than AgentInstallation, owns the
 * idempotency marker because installation rows can be recreated after an
 * uninstall.
 */
export async function maybeFireFirstContact({
  agentName,
  instanceId,
  podId,
  installedByUserId,
  installerIsAgent,
}: FirstContactOptions): Promise<void> {
  if (installerIsAgent) return;

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
    if ((error as { code?: number })?.code === 11000) return;
    throw error;
  }

  if (result?.lastErrorObject?.updatedExisting === true || result?.value != null) {
    return;
  }

  try {
    await AgentEventService.enqueue({
      agentName: safeAgentName,
      instanceId: safeInstanceId,
      podId: safePodId,
      type: 'first_contact',
      payload: {
        content: FIRST_CONTACT_CUE,
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
  }
}

export default { maybeFireFirstContact };
