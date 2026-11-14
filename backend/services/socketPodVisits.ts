/**
 * F512: a browser socket's pod joins and leaves, as the mention email reads
 * them (an open pod is a seen mention). Kept out of server.ts so the order of
 * the steps can be tested with a fake socket.
 *
 * The join time is taken before the authorization wait, so a leave that lands
 * during it stays later than this open. A join that was abandoned during the
 * wait (the pod was left, or the socket disconnected) does nothing after it:
 * no room, no joinedPods entry, no open stamp. Otherwise the stamp, taken
 * before the wait, could read a mention as seen by someone who never saw it.
 */

type PodSocket = {
  userId?: unknown;
  connected?: boolean;
  data: { joinedPods: Set<unknown>; pendingJoins: Set<unknown> };
  join: (room: string) => unknown;
  leave: (room: string) => unknown;
};
type Stamps = {
  stampPodOpened: (userId: unknown, podId: unknown, at: Date) => Promise<void>;
  stampPodClosed: (userId: unknown, podIds: unknown[]) => Promise<void>;
};

/** Returns the authorized pod, or null when the join was refused or abandoned. */
export const joinPodRoom = async <Pod>(
  socket: PodSocket,
  podId: unknown,
  authorize: () => Promise<Pod | null | undefined>,
  stamps: Stamps,
): Promise<Pod | null> => {
  const joinedAt = new Date();
  socket.data.pendingJoins.add(podId);
  let pod: Pod | null | undefined;
  let stillWanted = false;
  try {
    pod = await authorize();
  } finally {
    // A leave during the wait took the pod out of pendingJoins; a disconnect
    // cleared `connected`. Read both before this join's own entry goes.
    stillWanted = socket.connected !== false && socket.data.pendingJoins.has(podId);
    socket.data.pendingJoins.delete(podId);
  }
  if (!pod || !stillWanted) return null;
  socket.join(`pod_${podId}`);
  socket.data.joinedPods.add(podId);
  void stamps.stampPodOpened(socket.userId, podId, joinedAt);
  return pod;
};

/** True when the socket had this pod open, or was joining it. */
export const leavePodRoom = (socket: PodSocket, podId: unknown, stamps: Stamps): boolean => {
  socket.leave(`pod_${podId}`);
  // Only a pod this socket joined, or is joining, gets a close stamp: any
  // other id would add a visit row for a pod the person never opened.
  const wasOpen = socket.data.joinedPods.has(podId) || socket.data.pendingJoins.has(podId);
  socket.data.joinedPods.delete(podId);
  // Abandons a join still waiting on authorization (see joinPodRoom).
  socket.data.pendingJoins.delete(podId);
  if (wasOpen) void stamps.stampPodClosed(socket.userId, [podId]);
  return wasOpen;
};

export default { joinPodRoom, leavePodRoom };
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { joinPodRoom, leavePodRoom };
