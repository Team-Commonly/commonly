const request = require('supertest');
const express = require('express');

// Both write routes on /api/activity landed a row into an arbitrary pod for any
// authenticated caller. `/create` mattered most because `type` comes straight
// off the body and `Activity.approval.status` defaults to 'pending', so the row
// materialises exactly the two fields `getPendingApprovals` filters on — i.e. it
// arrives in that pod's ADMINS' decision queue with attacker-chosen content.
// Every case below asserts the write did not happen, not just the status code.

const CALLER = 'caller-1';
const OTHER = 'someone-else';

const mockAuth = () => jest.doMock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = CALLER;
  next();
});

const podFindById = jest.fn();
const mockPod = (pod) => {
  podFindById.mockImplementation(() => ({ select: () => ({ lean: async () => pod }) }));
  jest.doMock('../../../models/Pod', () => ({ findById: podFindById }));
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', require('../../../routes/activity'));
  return app;
};

const setup = (pod) => {
  mockAuth();
  podFindById.mockReset();
  mockPod(pod);
  const create = jest.fn(async () => ({
    _id: { toString: () => 'act-1' }, type: 'message', action: 'message', content: 'x', createdAt: new Date(),
  }));
  jest.doMock('../../../models/Activity', () => ({ create }));
  jest.doMock('../../../models/User', () => ({
    findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ username: 'someone' }) }) })),
  }));
  const seedPodActivities = jest.fn(async () => ({ success: true, count: 4 }));
  jest.doMock('../../../services/activityService', () => ({
    seedPodActivities, isAgentUsername: jest.fn(() => false),
  }));
  return { app: buildApp(), create, seedPodActivities };
};

const body = (over = {}) => ({
  type: 'message', action: 'message', content: 'hi', podId: 'pod-1', ...over,
});

describe('POST /api/activity/create — pod membership', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  it('refuses a non-member and writes nothing', async () => {
    const { app, create } = setup({ _id: 'pod-1', createdBy: OTHER, members: [OTHER] });
    await request(app).post('/api/activity/create').send(body()).expect(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a member', async () => {
    const { app, create } = setup({ _id: 'pod-1', createdBy: OTHER, members: [OTHER, CALLER] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('allows the creator, who is not always listed in members', async () => {
    const { app, create } = setup({ _id: 'pod-1', createdBy: CALLER, members: [] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('accepts a member listed as a populated subdocument', async () => {
    const { app, create } = setup({ _id: 'pod-1', createdBy: OTHER, members: [{ _id: CALLER }] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown pod rather than writing an orphan row', async () => {
    const { app, create } = setup(null);
    await request(app).post('/api/activity/create').send(body()).expect(404);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('POST /api/activity/create — the body\'s podId is untrusted input', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  // `podId` arrives as `unknown`. A raw object reaching findById would be read
  // as Mongo operators rather than as an id.
  // Asserted on the ARGUMENT rather than the status: what the mocked findById
  // returns for a malformed id is a property of the mock, but what the route
  // hands it is the thing under test.
  it('coerces the body podId to a string before it reaches a query', async () => {
    const { app } = setup({ _id: 'pod-1', createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/create').send(body({ podId: { $ne: null } }));
    expect(podFindById).toHaveBeenCalledTimes(1);
    expect(typeof podFindById.mock.calls[0][0]).toBe('string');
  });

  it('passes the params podId to the seeder lookup as a string too', async () => {
    const { app } = setup({ _id: 'pod-1', createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(200);
    expect(typeof podFindById.mock.calls[0][0]).toBe('string');
  });

  it('stores the resolved pod id, not the body\'s copy of it', async () => {
    const { app, create } = setup({ _id: 'resolved-pod', createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create.mock.calls[0][0].podId).toBe('resolved-pod');
  });
});

describe('POST /api/activity/create — the approval_needed kind', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  // Independent of membership: a member of the pod still cannot mint one here,
  // because this is the generic client-facing create and the approval kind is
  // what fills an admin decision queue.
  it('refuses approval_needed even from a member', async () => {
    const { app, create } = setup({ _id: 'pod-1', createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/create')
      .send(body({ type: 'approval_needed' })).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('positive control — the same member may create an ordinary kind', async () => {
    const { app, create } = setup({ _id: 'pod-1', createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/activity/seed/:podId — pod membership', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  // The seeder is the DESIGNED producer of approval_needed rows, so an ungated
  // seed route is the same injection by another door.
  it('refuses a non-member and never reaches the seeder', async () => {
    const { app, seedPodActivities } = setup({ _id: 'pod-1', createdBy: OTHER, members: [OTHER] });
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(403);
    expect(seedPodActivities).not.toHaveBeenCalled();
  });

  it('allows a member', async () => {
    const { app, seedPodActivities } = setup({ _id: 'pod-1', createdBy: OTHER, members: [CALLER] });
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(200);
    expect(seedPodActivities).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown pod', async () => {
    const { app, seedPodActivities } = setup(null);
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(404);
    expect(seedPodActivities).not.toHaveBeenCalled();
  });
});
