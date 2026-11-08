// F307: a person writing in a closed direct message brings it back. The REST
// write reopens through deliverMessageToAgents (covered in its own suite). The
// legacy socket sendMessage handler lives inline in server.ts and runs only on
// a full server boot, so this guards that its reopen hook stays wired: after
// the message is stored, before the broadcast, keyed on the authorized pod.
const fs = require('fs');
const path = require('path');

describe('socket sendMessage reopens a closed direct message', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../server.ts'), 'utf8');
  const start = src.indexOf("'sendMessage',");
  const handler = src.slice(start, src.indexOf("socket.on(", start + 1) > 0 ? src.indexOf("socket.on(", start + 1) : undefined);

  test('the handler calls reopenIfClosed for an agent-room, on the authorized pod', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).toMatch(/podInstance\.type === 'agent-room'[\s\S]*?reopenIfClosed\(podInstance\._id\)/);
  });

  test('the reopen runs after the store and before the broadcast', () => {
    const stored = handler.indexOf('message = written.message');
    const reopen = handler.indexOf('reopenIfClosed(podInstance._id)');
    const broadcast = handler.indexOf('// Broadcast message to all users in the pod room');
    expect(stored).toBeGreaterThan(-1);
    expect(reopen).toBeGreaterThan(stored);
    expect(broadcast).toBeGreaterThan(reopen);
  });
});
