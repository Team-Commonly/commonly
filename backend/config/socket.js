/**
 * Socket.IO instance manager
 * Provides a way for services to access the socket instance
 */

let io = null;

module.exports = {
  init: (socketInstance) => {
    io = socketInstance;
  },
  
  getIO: () => {
    if (!io) {
      throw new Error('Socket.io not initialized!');
    }
    return io;
  }
};