// F626
jest.mock('../../../models/User', () => ({}));

jest.mock('../../../models/Installable', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));

// The installableId claim is always free here; see marketplace.idClaim.test.js.
jest.mock('../../../models/SchedulerHeartbeatLease', () => ({
  findOneAndUpdate: jest.fn().mockResolvedValue({}),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  findOne: jest.fn().mockResolvedValue(null),
}));

// The claim's fencing-token counter.
jest.mock('../../../models/SystemSetting', () => ({
  findOneAndUpdate: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ value: { seq: 1 } }) })),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    findOneAndUpdate: jest.fn(),
    findOne: jest.fn().mockResolvedValue(null),
    deleteOne: jest.fn(),
    updateOne: jest.fn(),
  },
  AgentInstallation: {
    countDocuments: jest.fn(),
  },
}));

const Installable = require('../../../models/Installable');
const { AgentRegistry } = require('../../../models/AgentRegistry');
const router = require('../../../routes/marketplace-api');
const {
  DRIVER_TEXT, getRouteHandler, makeRes, expectNoLeak,
} = require('../../utils/routeHandler');

// F626: publish and fork answer an unexpected failure with fixed text.
describe('marketplace publish and fork 500s', () => {
  let errorSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const user = { id: 'user-1', username: 'nova' };

  it('publish: a Mongo failure answers fixed text and logs the cause', async () => {
    Installable.findOne.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await getRouteHandler(router, '/publish', 'post')({
      userId: 'user-1',
      user,
      body: { installableId: '@nova/my-agent', name: 'My Agent', version: '1.0.0', kind: 'agent', scope: 'pod', components: [] },
    }, res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Failed to publish' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('[marketplace] publish error:');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('fork: a Mongo failure answers fixed text and logs the cause', async () => {
    Installable.findOne.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await getRouteHandler(router, '/fork', 'post')({
      userId: 'user-1',
      user,
      body: { sourceInstallableId: '@a/src', newInstallableId: '@nova/copy' },
    }, res);
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'Failed to fork' });
    expectNoLeak(out);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('[marketplace] fork error:');
  });

  it('a 400 we wrote still passes through', async () => {
    const { res, out } = makeRes();
    await getRouteHandler(router, '/fork', 'post')({ userId: 'user-1', user, body: {} }, res);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: 'sourceInstallableId and newInstallableId are required' });
  });
});
