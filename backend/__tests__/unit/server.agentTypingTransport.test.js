const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.resolve(__dirname, '../../server.ts'), 'utf8');

describe('server agent typing transport', () => {
  it('does not relay browser-supplied agent typing events', () => {
    expect(serverSource).not.toContain('agent_typing_start');
    expect(serverSource).not.toContain('agent_typing_stop');
  });

  it('keeps the server-side typing service bound to Socket.IO', () => {
    expect(serverSource).toContain(
      "const { bindSocketIO: bindAgentTypingSocketIO } = require('./services/agentTypingService');",
    );
    expect(serverSource).toContain('bindAgentTypingSocketIO(io);');
  });
});
