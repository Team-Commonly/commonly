/* eslint-disable global-require -- modules load after the bus mock */
/**
 * Each piece of per-process state F598 shares over the process bus publishes
 * when it changes here, and applies a sibling's message to its own copy.
 */
const mockPublish = jest.fn();
const mockHandlers = new Map();
jest.mock('../../../services/processBus', () => ({
  publish: (...a) => mockPublish(...a),
  subscribe: (channel, handler) => mockHandlers.set(channel, handler),
  startProcessBus: jest.fn(),
}));

beforeEach(() => mockPublish.mockClear());

describe('cloud-runtime entitlement cache', () => {
  test('a clear here is published, and a sibling clear empties this process', () => {
    const { clearCloudRuntimeCache } = require('../../../services/cloudRuntimeOwnership');
    clearCloudRuntimeCache();
    expect(mockPublish).toHaveBeenCalledWith('cloud-runtime-cache-clear');
    expect(typeof mockHandlers.get('cloud-runtime-cache-clear')).toBe('function');
  });
});

describe('hosted-MCP drift cache', () => {
  test('a forget here is published with its connection id', () => {
    const { forgetHostedMcpDrift } = require('../../../services/hostedMcpToolDefinitions');
    forgetHostedMcpDrift('conn-1');
    expect(mockPublish).toHaveBeenCalledWith('hosted-mcp-drift-forget', { connectionId: 'conn-1' });
    // A malformed sibling message is ignored rather than thrown.
    expect(() => mockHandlers.get('hosted-mcp-drift-forget')({ connectionId: 42 })).not.toThrow();
  });
});

describe('global model config cache', () => {
  test('a sibling save drops this process copy, so the next read goes to the database', async () => {
    const SystemSetting = require('../../../models/SystemSetting');
    const findOne = jest.spyOn(SystemSetting, 'findOne').mockReturnValue({ lean: async () => null });
    const service = require('../../../services/globalModelConfigService');
    service.resetCache();
    await service.getConfig();
    await service.getConfig();
    expect(findOne).toHaveBeenCalledTimes(1);

    mockHandlers.get('global-model-config-changed')({});
    await service.getConfig();
    expect(findOne).toHaveBeenCalledTimes(2);
  });
});

describe('agent socket wakes', () => {
  test('a wake for an agent this process does not hold goes to the siblings, and one they relay is delivered here', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentEventService', () => ({ list: jest.fn() }));
      const service = require('../../../services/agentWebSocketService');
      const emit = jest.fn();
      const namespace = { use: jest.fn(), on: jest.fn() };
      service.init({ of: () => namespace });

      const event = {
        _id: 'e1', agentName: 'scout', instanceId: 'default', type: 'chat.mention', payload: { a: 1 },
      };
      expect(service.pushEvent(event)).toBe(false);
      expect(mockPublish).toHaveBeenCalledWith('agent-ws-push', { event });

      // The sibling's relay, for a socket this process holds. A queued event
      // is never emitted raw: the socket replays through list(), which claims.
      const socket = { emit };
      const replay = jest.spyOn(service, 'replayPendingEvents').mockResolvedValue(undefined);
      service.connectedAgents.set('scout:default', { socket });
      mockHandlers.get('agent-ws-push')({ event });
      expect(replay).toHaveBeenCalledWith(socket);
      expect(emit).not.toHaveBeenCalled();
      // A native event (born claimed) goes out as a delivery, nonce in payload.
      mockHandlers.get('agent-ws-push')({ event: { ...event, deliveryId: 'n1' } });
      expect(emit).toHaveBeenCalledWith('event', expect.objectContaining({ _id: 'e1', payload: { a: 1, deliveryId: 'n1' } }));

      // Held here: delivered locally, nothing published.
      mockPublish.mockClear();
      expect(service.pushEvent(event)).toBe(true);
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });
});
