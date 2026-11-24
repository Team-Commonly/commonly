import mongoose from 'mongoose';
import Pod from '../models/Pod';
import { disconnectRoom, fetchRoomSockets, leaveRoom } from '../config/socketRooms';

// Every browser socket joins this room after its handshake. Each operation
// below applies to this process's sockets at once and reaches the other
// backend processes through the Redis adapter (config/socketRooms).
export const sessionSocketRoom = (userId: string): string => `session_user_${userId}`;

const POD_ROOM_PREFIX = 'pod_';

const getIOOrNull = () => {
  // The HTTP service tests do not start Socket.IO; production initializes it
  // before accepting requests.
  // eslint-disable-next-line global-require
  const socketConfig = require('../config/socket');
  try {
    return socketConfig.getIO();
  } catch {
    return null;
  }
};

export const disconnectUserSessionSockets = (userId: string): void => {
  const io = getIOOrNull();
  if (!io) return;
  disconnectRoom(io, sessionSocketRoom(userId));
};

// A browser socket is let into a pod room once, at joinPod, by canViewPod.
// Nothing re-checks it after that, so when a user leaves a pod or is removed
// from one, their open sockets re-run that check for every pod room they are
// in and leave the rooms it now refuses. One membership change can end more
// than one room: an agent-dm is viewable through any pod shared with either
// agent (§3.7), so leaving that pod can end the DM's room too. Rooms the user
// may still view (a global admin, another shared pod) stay joined.
// Never throws: the membership change has already been saved.
export const leaveUnviewablePodRooms = async (userId: string): Promise<void> => {
  const io = getIOOrNull();
  if (!io) return;
  try {
    const room = sessionSocketRoom(userId);
    const sockets = await fetchRoomSockets(io, room);
    const podIds = new Set<string>();
    sockets.forEach(({ rooms }) => rooms.forEach((room) => {
      if (room.startsWith(POD_ROOM_PREFIX)) podIds.add(room.slice(POD_ROOM_PREFIX.length));
    }));
    if (!podIds.size) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const DMService = require('./dmService').default || require('./dmService');
    await Promise.all([...podIds].map(async (podId) => {
      const pod = mongoose.isValidObjectId(podId)
        ? await Pod.findById(podId).select('type members').lean()
        : null;
      if (pod && await DMService.canViewPod(userId, pod)) return;
      leaveRoom(io, room, `${POD_ROOM_PREFIX}${podId}`);
    }));
  } catch (err) {
    console.warn('[session-socket] pod room re-check failed:', (err as Error).message);
  }
};
