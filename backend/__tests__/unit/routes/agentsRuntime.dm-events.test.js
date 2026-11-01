jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
// The route's authentication middleware is mocked above. Its import graph
// still reaches uploads.ts, which imports jsonwebtoken; keep that unrelated
// Node-26-incompatible dependency out of this polling-scope unit test.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../services/agentEventService', () => ({
  list: jest.fn(),
  listInboxPage: jest.fn(),
  renewDelivery: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn(),
}));
jest.mock('../../../services/agentListenerCheckIn', () => ({
  recordListenerCheckIn: jest.fn(),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/dmService', () => ({
  getOrCreateAdminDMPod: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

const AgentEventService = require('../../../services/agentEventService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const { recordListenerCheckIn } = require('../../../services/agentListenerCheckIn');
const DMService = require('../../../services/dmService');
const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const router = require('../../../routes/agentsRuntime');

const getRouteHandler = (path, method) => {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

describe('agentsRuntime DM and event pod coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes agent-admin DM pod ids in GET /events polling scope', async () => {
    const handler = getRouteHandler('/events', 'get');

    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'dm-pod-1' }]),
    });
    AgentEventService.listInboxPage.mockResolvedValue({ events: [], inboxCount: 0 });

    const req = {
      query: {},
      agentInstallation: { agentName: 'openclaw', instanceId: 'liz', podId: 'pod-1' },
      agentInstallations: [{ podId: 'pod-1' }],
      agentUser: { _id: 'bot-user-1', username: 'openclaw-liz' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(AgentEventService.listInboxPage).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'liz',
      podIds: ['pod-1', 'dm-pod-1'],
    }));
    expect(res.json).toHaveBeenCalledWith({ events: [], inboxCount: 0 });
  });

  it('stamps a listener check-in for the polling token on GET /events', async () => {
    const handler = getRouteHandler('/events', 'get');
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    AgentEventService.listInboxPage.mockResolvedValue({ events: [], inboxCount: 0 });

    const req = {
      query: {},
      agentInstallation: { agentName: 'openclaw', instanceId: 'liz', podId: 'pod-1' },
      agentInstallations: [{ podId: 'pod-1' }],
      agentUser: { _id: 'bot-user-1', username: 'openclaw-liz' },
      agentTokenHash: 'hashed-token',
    };
    await handler(req, { status: jest.fn().mockReturnThis(), json: jest.fn() });

    expect(recordListenerCheckIn).toHaveBeenCalledWith('bot-user-1', 'hashed-token');
  });

  it('creates or returns DM pod via POST /dm', async () => {
    const handler = getRouteHandler('/dm', 'post');

    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          agentName: 'openclaw',
          instanceId: 'liz',
          podId: 'pod-1',
          installedBy: 'user-1',
        },
      ]),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: 'bot-user-1' });
    DMService.getOrCreateAdminDMPod.mockResolvedValue({ _id: 'dm-pod-1', type: 'agent-admin' });

    const req = {
      userId: 'user-1',
      body: { agentName: 'openclaw', instanceId: 'liz' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(AgentInstallation.find).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'liz',
      status: 'active',
    }));
    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalledWith('openclaw', { instanceId: 'liz' });
    expect(DMService.getOrCreateAdminDMPod).toHaveBeenCalledWith('bot-user-1', 'user-1', {
      agentName: 'openclaw',
      instanceId: 'liz',
    });
    expect(res.json).toHaveBeenCalledWith({ dmPod: { _id: 'dm-pod-1', type: 'agent-admin' } });
  });
});


describe('inbox delivery renewal route', () => {
  const eventId = '0123456789abcdef01234567';
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  test('uses authenticated seat/instance, ignoring identity supplied in the body', async () => {
    AgentEventService.renewDelivery.mockResolvedValue(true);
    const res = response();
    await getRouteHandler('/events/renew', 'post')({
      agentInstallation: { agentName: 'wren', instanceId: 'writer-instance' },
      body: { agentName: 'victim', instanceId: 'victim-instance', events: [{ eventId, deliveryId: 'nonce' }] },
    }, res);
    expect(AgentEventService.renewDelivery).toHaveBeenLastCalledWith(eventId, 'wren', 'writer-instance', 'nonce');
    expect(res.json).toHaveBeenCalledWith({ renewed: [eventId] });
  });
  test('a renew is a listener check-in, so a seat inside a long turn stays listening', async () => {
    AgentEventService.renewDelivery.mockResolvedValue(true);
    recordListenerCheckIn.mockClear();
    await getRouteHandler('/events/renew', 'post')({
      agentInstallation: { agentName: 'wren', instanceId: 'writer-instance' },
      agentUser: { _id: 'bot-user-1' },
      agentTokenHash: 'hashed-token',
      body: { events: [{ eventId, deliveryId: 'nonce' }] },
    }, response());
    expect(recordListenerCheckIn).toHaveBeenCalledWith('bot-user-1', 'hashed-token');
  });
  test('a malformed renew is not a check-in', async () => {
    recordListenerCheckIn.mockClear();
    await getRouteHandler('/events/renew', 'post')({
      agentUser: { _id: 'bot-user-1' }, agentTokenHash: 'hashed-token', body: { events: [] },
    }, response());
    expect(recordListenerCheckIn).not.toHaveBeenCalled();
  });
  test.each([undefined, [], Array(51).fill({ eventId, deliveryId: 'nonce' }),
    [{ eventId, deliveryId: '' }], [{ eventId: {}, deliveryId: 'nonce' }]])('rejects malformed or unbounded input %j', async (events) => {
    AgentEventService.renewDelivery.mockClear();
    const res = response();
    await getRouteHandler('/events/renew', 'post')({ body: { events }, agentInstallation: { agentName: 'wren' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(AgentEventService.renewDelivery).not.toHaveBeenCalled();
  });
});
