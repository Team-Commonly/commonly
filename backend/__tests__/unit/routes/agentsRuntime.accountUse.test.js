// F662: GET /events stamps payload.accountUse on pages served to own-machine
// (BYO) seats only, within a fixed query budget.
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({
  listInboxPage: jest.fn(),
  hasPendingWake: jest.fn(),
  unclaimUnsent: jest.fn(),
  signalAgentTyping: jest.fn(),
}));
jest.mock('../../../services/agentListenerCheckIn', () => ({ recordListenerCheckIn: jest.fn() }));
jest.mock('../../../services/installIntroOnListen', () => ({ settleIntroOnRequestCheckIn: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/agentEventWaiters', () => ({
  ...jest.requireActual('../../../services/agentEventWaiters'),
  waitForAgentEvent: jest.fn(),
}));
jest.mock('../../../middleware/agentRuntimeAuthRecheck', () => ({ recheckHeldRuntimeAuth: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn(), updateMany: jest.fn() },
}));

const AgentEventService = require('../../../services/agentEventService');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const router = require('../../../routes/agentsRuntime');

const OWNER = '64b000000000000000000001';
const HUMAN = '64b000000000000000000002';
const BOT = '64b000000000000000000007';
const POD = '64c000000000000000000001';

const getHandler = () => {
  const layer = router.stack.find((entry) => entry.route?.path === '/events' && entry.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const chain = (rows) => {
  const q = { select: jest.fn(() => q), limit: jest.fn(() => q), lean: jest.fn(() => Promise.resolve(rows)) };
  return q;
};

// The scope read (resolveEventPodScope) also calls Pod.find, for agent-admin
// DM pods; the stamp's own query is the one keyed on `_id`.
const isScopeQuery = (filter) => filter?.type === 'agent-admin';
const stampPodQueries = () => Pod.find.mock.calls.filter(([filter]) => !isScopeQuery(filter));

const agentUser = {
  _id: BOT,
  username: 'claude-sam',
  isBot: true,
  botMetadata: { agentName: 'claude', instanceId: 'sam', ownerUserId: OWNER },
};

const reqFor = (runtime) => ({
  query: {},
  agentInstallation: { agentName: 'claude', instanceId: 'sam', podId: POD, config: { runtime } },
  agentInstallations: [{ podId: POD, config: { runtime } }],
  agentUser,
});

const resMock = () => ({
  status: jest.fn().mockReturnThis(), json: jest.fn(), on: jest.fn(), off: jest.fn(), once: jest.fn(),
});

const page = () => ({
  events: [
    { _id: 'e1', type: 'chat.mention', podId: POD, payload: { userId: HUMAN } },
    { _id: 'e2', type: 'chat.mention', podId: POD, payload: { userId: OWNER } },
  ],
  inboxCount: 2,
});

beforeEach(() => {
  jest.clearAllMocks();
  Pod.find.mockImplementation((filter) => chain(isScopeQuery(filter) ? [] : [
    { _id: POD, type: 'chat', publicRead: false, communityListed: true },
  ]));
  User.find.mockImplementation(() => chain([
    { _id: OWNER, username: 'sam', isBot: false },
    { _id: HUMAN, username: 'ana', isBot: false },
  ]));
});

describe('GET /events accountUse stamp', () => {
  it('stamps each event served to a BYO seat', async () => {
    AgentEventService.listInboxPage.mockResolvedValue(page());
    const res = resMock();
    await getHandler()(reqFor({ runtimeType: 'webhook', host: 'byo' }), res);
    const { events } = res.json.mock.calls[0][0];
    expect(events[0].payload.accountUse).toEqual({
      v: 1,
      ownerUserId: OWNER,
      ownerName: 'sam',
      requesterUserIds: [HUMAN],
      requesterKind: 'human',
      pod: { type: 'chat', publicRead: false, communityListed: true, joinPolicy: 'open' },
      requesterSharesTeamPod: null,
    });
    expect(events[1].payload.accountUse.requesterUserIds).toEqual([OWNER]);
  });

  it('stamps the unstamped polling-webhook shape too', async () => {
    AgentEventService.listInboxPage.mockResolvedValue(page());
    const res = resMock();
    await getHandler()(reqFor({ runtimeType: 'webhook' }), res);
    expect(res.json.mock.calls[0][0].events[0].payload.accountUse).toBeDefined();
  });

  it('does not stamp a hosted or native seat, and makes no stamp query', async () => {
    for (const runtime of [{ runtimeType: 'native' }, { runtimeType: 'moltbot', host: 'cloud' }]) {
      jest.clearAllMocks();
      AgentEventService.listInboxPage.mockResolvedValue(page());
      const res = resMock();
      // eslint-disable-next-line no-await-in-loop
      await getHandler()(reqFor(runtime), res);
      const { events } = res.json.mock.calls[0][0];
      events.forEach((event) => expect(event.payload.accountUse).toBeUndefined());
      expect(stampPodQueries()).toHaveLength(0);
      expect(User.find).not.toHaveBeenCalled();
    }
  });

  it('an empty page makes no Pod or User query for the stamp', async () => {
    AgentEventService.listInboxPage.mockResolvedValue({ events: [], inboxCount: 0 });
    const res = resMock();
    await getHandler()(reqFor({ runtimeType: 'webhook', host: 'byo' }), res);
    expect(res.json).toHaveBeenCalledWith({ events: [], inboxCount: 0 });
    expect(stampPodQueries()).toHaveLength(0);
    expect(User.find).not.toHaveBeenCalled();
  });

  it('a non-empty page makes exactly one Pod.find and one User.find for the stamp', async () => {
    AgentEventService.listInboxPage.mockResolvedValue(page());
    await getHandler()(reqFor({ runtimeType: 'webhook', host: 'byo' }), resMock());
    expect(stampPodQueries()).toHaveLength(1);
    expect(User.find).toHaveBeenCalledTimes(1);
  });

  it('names the owner from the runtime credential auth loaded when the bot has none', async () => {
    AgentEventService.listInboxPage.mockResolvedValue(page());
    const req = reqFor({ runtimeType: 'webhook', host: 'byo' });
    req.agentUser = { ...agentUser, botMetadata: { agentName: 'claude', instanceId: 'sam' } };
    req.agentCredential = { ownerUserId: OWNER };
    const res = resMock();
    await getHandler()(req, res);
    const stamp = res.json.mock.calls[0][0].events[0].payload.accountUse;
    expect(stamp.ownerUserId).toBe(OWNER);
    expect(stamp.ownerName).toBe('sam');
    expect(User.find).toHaveBeenCalledTimes(1);
  });

  it('a failing stamp still serves the page, unstamped', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    User.find.mockImplementation(() => { throw new Error('mongo down'); });
    AgentEventService.listInboxPage.mockResolvedValue(page());
    const res = resMock();
    await getHandler()(reqFor({ runtimeType: 'webhook', host: 'byo' }), res);
    expect(res.status).not.toHaveBeenCalled();
    const { events } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(2);
    events.forEach((event) => expect(event.payload.accountUse).toBeUndefined());
    warn.mockRestore();
  });

  it('stamps a page a long-poll answers after a wake', async () => {
    // eslint-disable-next-line global-require
    const { waitForAgentEvent: wait } = require('../../../services/agentEventWaiters');
    wait.mockResolvedValue('woken');
    // eslint-disable-next-line global-require
    const { recheckHeldRuntimeAuth } = require('../../../middleware/agentRuntimeAuthRecheck');
    const req = reqFor({ runtimeType: 'webhook', host: 'byo' });
    recheckHeldRuntimeAuth.mockResolvedValue({
      installations: req.agentInstallations, installation: req.agentInstallation,
    });
    AgentEventService.listInboxPage
      .mockResolvedValueOnce({ events: [], inboxCount: 0 })
      .mockResolvedValueOnce(page());
    req.query.waitMs = '5000';
    const res = resMock();
    await getHandler()(req, res);
    expect(wait).toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].events[0].payload.accountUse.requesterUserIds).toEqual([HUMAN]);
    expect(stampPodQueries()).toHaveLength(1);
    expect(User.find).toHaveBeenCalledTimes(1);
  });
});
