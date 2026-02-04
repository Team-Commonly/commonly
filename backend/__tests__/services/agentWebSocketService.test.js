jest.mock('../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock('../../models/User', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));

const { hash } = require('../../utils/secret');
const { AgentInstallation } = require('../../models/AgentRegistry');
const User = require('../../models/User');

describe('agentWebSocketService', () => {
  let agentWebSocketService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear module cache to get fresh instance
    jest.resetModules();
    agentWebSocketService = require('../../services/agentWebSocketService');
  });

  describe('validateAgentToken', () => {
    it('validates cm_agent tokens using hashed runtime tokens', async () => {
      User.findOne.mockResolvedValue(null);
      AgentInstallation.findOne.mockResolvedValue({
        _id: 'install-1',
        agentName: 'openclaw',
        instanceId: 'default',
        podId: 'pod-123',
      });
      AgentInstallation.updateOne.mockResolvedValue({});

      const token = 'cm_agent_testtoken';
      const result = await agentWebSocketService.validateAgentToken(token);

      expect(AgentInstallation.findOne).toHaveBeenCalledWith({
        'runtimeTokens.tokenHash': hash(token),
        status: 'active',
      });
      expect(AgentInstallation.updateOne).toHaveBeenCalledWith(
        { _id: 'install-1', 'runtimeTokens.tokenHash': hash(token) },
        { $set: { 'runtimeTokens.$.lastUsedAt': expect.any(Date) } },
      );
      expect(result).toEqual({
        agentName: 'openclaw',
        instanceId: 'default',
        podId: 'pod-123',
      });
    });

    it('validates cm_agent tokens using shared runtime tokens on bot users', async () => {
      User.findOne.mockResolvedValue({
        _id: 'user-1',
        isBot: true,
        username: 'openclaw',
        botMetadata: { agentName: 'openclaw', instanceId: 'cuz' },
      });
      User.updateOne.mockResolvedValue({});

      const token = 'cm_agent_sharedtoken';
      const result = await agentWebSocketService.validateAgentToken(token);

      expect(User.findOne).toHaveBeenCalledWith({
        'agentRuntimeTokens.tokenHash': hash(token),
        isBot: true,
      });
      expect(User.updateOne).toHaveBeenCalledWith(
        { _id: 'user-1', 'agentRuntimeTokens.tokenHash': hash(token) },
        { $set: { 'agentRuntimeTokens.$.lastUsedAt': expect.any(Date) } },
      );
      expect(AgentInstallation.findOne).not.toHaveBeenCalled();
      expect(result).toEqual({
        agentName: 'openclaw',
        instanceId: 'cuz',
      });
    });
  });

  describe('ping/pong mechanism', () => {
    let mockIo;
    let mockNamespace;
    let mockSocket;
    let connectionHandler;

    beforeEach(() => {
      jest.useFakeTimers();

      mockSocket = {
        id: 'socket-1',
        agentKey: 'openclaw:default',
        connected: true,
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn(),
      };

      mockNamespace = {
        use: jest.fn((middleware) => {
          // Call middleware with mock socket and next function
          const next = jest.fn();
          mockSocket.handshake = { auth: { token: 'test-token' } };
          mockSocket.agentName = 'openclaw';
          mockSocket.instanceId = 'default';
          mockSocket.agentKey = 'openclaw:default';
          mockSocket.subscribedPods = new Set();
        }),
        on: jest.fn((event, handler) => {
          if (event === 'connection') {
            connectionHandler = handler;
          }
        }),
        to: jest.fn(() => mockNamespace),
      };

      mockIo = {
        of: jest.fn(() => mockNamespace),
      };
    });

    afterEach(() => {
      jest.useRealTimers();
      if (agentWebSocketService.pingInterval) {
        agentWebSocketService.stopPingInterval();
      }
    });

    it('starts ping interval on initialization', () => {
      agentWebSocketService.init(mockIo);

      expect(agentWebSocketService.pingInterval).not.toBeNull();
    });

    it('stores lastPong timestamp when agent connects', () => {
      AgentInstallation.findOne.mockResolvedValue({
        agentName: 'openclaw',
        instanceId: 'default',
      });

      agentWebSocketService.init(mockIo);

      // Simulate connection
      if (connectionHandler) {
        connectionHandler(mockSocket);
      }

      const agentData = agentWebSocketService.connectedAgents.get('openclaw:default');
      expect(agentData).toBeDefined();
      expect(agentData.socket).toBe(mockSocket);
      expect(agentData.lastPong).toBeGreaterThan(0);
    });

    it('updates lastPong timestamp on pong event', () => {
      AgentInstallation.findOne.mockResolvedValue({
        agentName: 'openclaw',
        instanceId: 'default',
      });

      agentWebSocketService.init(mockIo);

      // Simulate connection
      if (connectionHandler) {
        connectionHandler(mockSocket);
      }

      // Capture the pong handler
      const pongHandler = mockSocket.on.mock.calls.find(
        (call) => call[0] === 'pong',
      )?.[1];

      expect(pongHandler).toBeDefined();

      // Store initial timestamp
      const agentData = agentWebSocketService.connectedAgents.get('openclaw:default');
      const initialPong = agentData.lastPong;

      // Advance time and trigger pong
      jest.advanceTimersByTime(5000);
      pongHandler();

      // lastPong should be updated
      expect(agentData.lastPong).toBeGreaterThan(initialPong);
    });

    it('sends ping to all connected agents every 30 seconds', () => {
      AgentInstallation.findOne.mockResolvedValue({
        agentName: 'openclaw',
        instanceId: 'default',
      });

      agentWebSocketService.init(mockIo);

      // Simulate connection
      if (connectionHandler) {
        connectionHandler(mockSocket);
      }

      mockSocket.emit.mockClear();

      // Advance time by 30 seconds
      jest.advanceTimersByTime(30000);

      expect(mockSocket.emit).toHaveBeenCalledWith('ping');
    });

    it('logs warning for stale connections without pong', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      AgentInstallation.findOne.mockResolvedValue({
        agentName: 'openclaw',
        instanceId: 'default',
      });

      agentWebSocketService.init(mockIo);

      // Simulate connection
      if (connectionHandler) {
        connectionHandler(mockSocket);
      }

      // Advance time by 95 seconds (past 90 second stale threshold)
      jest.advanceTimersByTime(95000);

      // Should log stale connection
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[agent-ws] Stale connection detected: openclaw:default'),
      );

      consoleSpy.mockRestore();
    });

    it('clears ping interval when stopped', () => {
      agentWebSocketService.init(mockIo);

      const intervalId = agentWebSocketService.pingInterval;
      expect(intervalId).not.toBeNull();

      agentWebSocketService.stopPingInterval();

      expect(agentWebSocketService.pingInterval).toBeNull();
    });
  });
});
