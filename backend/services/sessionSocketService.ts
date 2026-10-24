// Every browser socket joins this room after its handshake. The Redis adapter
// forwards disconnectSockets to the other backend pods as well.
export const sessionSocketRoom = (userId: string): string => `session_user_${userId}`;

export const disconnectUserSessionSockets = (userId: string): void => {
  // The HTTP service tests do not start Socket.IO; production initializes it
  // before accepting requests.
  // eslint-disable-next-line global-require
  const socketConfig = require('../config/socket');
  let io;
  try {
    io = socketConfig.getIO();
  } catch {
    return;
  }
  io.in(sessionSocketRoom(userId)).disconnectSockets(true);
};
