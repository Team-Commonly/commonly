// F307: a person closes the direct message pod they hold with an agent
// (Pod.type 'agent-room'). Closing hides it from their lists and deletes
// nothing: the agent's memory, history and installs stay, and the pod comes
// back the moment either side writes in it or the person opens Talk to again.
// One Pod.closedAt is enough, because an agent-room has exactly one human
// member (ADR-001 §3.10). Design frame: docs/design/artboards/f303.
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const User = require('../models/User');

export type CloseRefusal = 'pod_not_found' | 'not_agent_room' | 'not_room_member';

type RoomDoc = { _id: unknown; type?: string; members?: unknown[]; closedAt?: Date | null };

const isMember = (pod: RoomDoc, userId: string): boolean => (pod.members || [])
  .some((m) => String((m as { _id?: unknown })?._id || m) === userId);

const resolveRoom = async (podId: string, userId: string): Promise<{ pod?: RoomDoc; refusal?: CloseRefusal }> => {
  const pod = await Pod.findById(podId).select('type members closedAt').lean() as RoomDoc | null;
  // A non-member learns nothing about the pod, not even its type: same
  // answer as a missing one, as getPodById gives.
  if (!pod || !isMember(pod, userId)) return { refusal: 'pod_not_found' };
  if (pod.type !== 'agent-room') return { refusal: 'not_agent_room' };
  // The room's human is the one member who isn't a bot; the agent can't close it.
  const user = await User.findById(userId).select('isBot').lean() as { isBot?: boolean } | null;
  if (!user || user.isBot) return { refusal: 'not_room_member' };
  return { pod };
};

export const closeAgentRoom = async (podId: string, userId: string): Promise<{ closedAt?: Date; refusal?: CloseRefusal }> => {
  const { pod, refusal } = await resolveRoom(podId, userId);
  if (refusal || !pod) return { refusal: refusal || 'pod_not_found' };
  const closedAt = pod.closedAt || new Date();
  if (!pod.closedAt) await Pod.updateOne({ _id: pod._id }, { $set: { closedAt } });
  return { closedAt };
};

export const reopenAgentRoom = async (podId: string, userId: string): Promise<{ refusal?: CloseRefusal }> => {
  const { pod, refusal } = await resolveRoom(podId, userId);
  if (refusal || !pod) return { refusal: refusal || 'pod_not_found' };
  if (pod.closedAt) await Pod.updateOne({ _id: pod._id }, { $unset: { closedAt: 1 } });
  return {};
};

/**
 * Reopen on any write. The filter keys on _id and only matches a closed room,
 * so on every other pod this is one indexed no-op update. Never throws: a
 * failed reopen must not refuse the message that triggered it.
 */
export const reopenIfClosed = async (podId: unknown): Promise<void> => {
  if (!podId) return;
  try {
    await Pod.updateOne(
      { _id: podId, type: 'agent-room', closedAt: { $ne: null } },
      { $unset: { closedAt: 1 } },
    );
  } catch (err) {
    console.warn('[agent-room] reopen on write failed:', (err as Error).message);
  }
};

/** List filter: a closed agent-room leaves the person's lists. Its URL still opens. */
export const dropClosedAgentRooms = <T extends { type?: string; closedAt?: Date | null }>(pods: T[]): T[] => (
  pods.filter((p) => p.type !== 'agent-room' || !p.closedAt)
);
