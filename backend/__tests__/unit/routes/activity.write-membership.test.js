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

const mockPod = (pod) => jest.doMock('../../../models/Pod', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: async () => pod }) })),
}));

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/activity', require('../../../routes/activity'));
  return app;
};

const setup = (pod) => {
  mockAuth();
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
    const { app, create } = setup({ createdBy: OTHER, members: [OTHER] });
    await request(app).post('/api/activity/create').send(body()).expect(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a member', async () => {
    const { app, create } = setup({ createdBy: OTHER, members: [OTHER, CALLER] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('allows the creator, who is not always listed in members', async () => {
    const { app, create } = setup({ createdBy: CALLER, members: [] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('accepts a member listed as a populated subdocument', async () => {
    const { app, create } = setup({ createdBy: OTHER, members: [{ _id: CALLER }] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown pod rather than writing an orphan row', async () => {
    const { app, create } = setup(null);
    await request(app).post('/api/activity/create').send(body()).expect(404);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('POST /api/activity/create — the approval_needed kind', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  // Independent of membership: a member of the pod still cannot mint one here,
  // because this is the generic client-facing create and the approval kind is
  // what fills an admin decision queue.
  it('refuses approval_needed even from a member', async () => {
    const { app, create } = setup({ createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/create')
      .send(body({ type: 'approval_needed' })).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('positive control — the same member may create an ordinary kind', async () => {
    const { app, create } = setup({ createdBy: CALLER, members: [CALLER] });
    await request(app).post('/api/activity/create').send(body()).expect(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/activity/seed/:podId — pod membership', () => {
  afterEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  // The seeder is the DESIGNED producer of approval_needed rows, so an ungated
  // seed route is the same injection by another door.
  it('refuses a non-member and never reaches the seeder', async () => {
    const { app, seedPodActivities } = setup({ createdBy: OTHER, members: [OTHER] });
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(403);
    expect(seedPodActivities).not.toHaveBeenCalled();
  });

  it('allows a member', async () => {
    const { app, seedPodActivities } = setup({ createdBy: OTHER, members: [CALLER] });
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(200);
    expect(seedPodActivities).toHaveBeenCalledTimes(1);
  });

  it('404s an unknown pod', async () => {
    const { app, seedPodActivities } = setup(null);
    await request(app).post('/api/activity/seed/pod-1').send({}).expect(404);
    expect(seedPodActivities).not.toHaveBeenCalled();
  });
});
