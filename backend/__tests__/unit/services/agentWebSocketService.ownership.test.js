// The agent socket reads runtime ownership at connect and on every replay.
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../models/AgentCredential', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findById: jest.fn().mockResolvedValue(null),
}));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const mockList = jest.fn().mockResolvedValue([]);
jest.mock('../../../services/agentEventService', () => ({
  acknowledge: jest.fn(),
  isSupersededDelivery: jest.fn(),
  isDeliveryNonceRequired: jest.fn(),
  list: (...a) => mockList(...a),
}));
const mockMayRun = jest.fn();
jest.mock('../../../services/cloudRuntimeOwnership', () => ({
  cloudRuntimeMayRun: (...a) => mockMayRun(...a),
}));

const agentWebSocketService = require('../../../services/agentWebSocketService');

const capture = () => {
  let middleware;
  agentWebSocketService.init({
    of: () => ({ use: (fn) => { middleware = fn; }, on: jest.fn() }),
  });
  return middleware;
};

describe('the agent socket and runtime ownership', () => {
  beforeEach(() => {
    mockList.mockClear();
    mockMayRun.mockReset();
  });

  test('refuses the connection of an agent whose owner may not run it', async () => {
    const middleware = capture();
    jest.spyOn(agentWebSocketService, 'validateAgentToken')
      .mockResolvedValue({ agentName: 'openclaw', instanceId: 'kit', agentUserId: 'bot-1' });
    mockMayRun.mockResolvedValue(false);
    const next = jest.fn();
    await middleware({ handshake: { auth: { token: 'cm_agent_x' } } }, next);
    expect(mockMayRun).toHaveBeenCalledWith('openclaw', 'kit');
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test('replays nothing to an already-connected socket once its owner may not run it', async () => {
    mockMayRun.mockResolvedValue(false);
    const socket = { agentName: 'openclaw', instanceId: 'kit', emit: jest.fn() };
    await agentWebSocketService.replayPendingEvents(socket);
    expect(mockList).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
