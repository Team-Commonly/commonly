// F626: a signed-in controller that hits an unexpected failure answers a 500
// with fixed text. The driver's message (a host, a SQL fragment, a constraint
// or collection name) goes to the server log through logOutboundFailure and
// never into the response body. Messages we wrote (404, 403) stay as they are.
const DRIVER_TEXT = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';
const LEAKS = ['db.internal.example', 'secret_table', 'ECONNREFUSED', 'relation'];

jest.mock('../../../models/pg/PodReadPoint', () => ({ get: jest.fn(), markRead: jest.fn() }));
jest.mock('../../../models/pg/ThreadUserState', () => ({
  follow: jest.fn(),
  unfollow: jest.fn(),
  setCollapsed: jest.fn(),
  markRead: jest.fn(),
  effectiveStateForPod: jest.fn(),
}));
jest.mock('../../../models/pg/Message', () => ({ resolveId: jest.fn() }));
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn().mockResolvedValue({ rows: [] }) } }));
jest.mock('../../../services/podWriteAccessService', () => ({
  getCallerId: (req) => String(req.user?._id || req.userId || ''),
  callerHasPodWriteAccess: jest.fn(),
}));
jest.mock('../../../services/podReadPointSeed', () => ({ seedPodReadPoint: jest.fn() }));
jest.mock('../../../services/communityPodService', () => ({ ensureUserInCommunityPod: jest.fn() }));
jest.mock('../../../services/emailService', () => ({ sendEmail: jest.fn() }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));

const PodReadPoint = require('../../../models/pg/PodReadPoint');
const PGMessage = require('../../../models/pg/Message');
const ThreadUserState = require('../../../models/pg/ThreadUserState');
const { callerHasPodWriteAccess } = require('../../../services/podWriteAccessService');
const User = require('../../../models/User');
const Post = require('../../../models/Post');
const podReadPoint = require('../../../controllers/podReadPointController');
const threadState = require('../../../controllers/threadStateController');
const authController = require('../../../controllers/authController');
const postController = require('../../../controllers/postController');

const POD = '0123456789abcdef01234567';
const makeRes = () => {
  const out = { status: 200, body: undefined };
  const res = {
    status: (n) => { out.status = n; return res; },
    json: (d) => { out.body = d; return res; },
    send: (d) => { out.body = d; return res; },
  };
  return { res, out };
};

let errorSpy;
const logged = () => JSON.stringify(errorSpy.mock.calls);

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const expectFixed500 = (out, label) => {
  expect(out.status).toBe(500);
  const body = JSON.stringify(out.body);
  LEAKS.forEach((leak) => expect(body).not.toContain(leak));
  Object.values(out.body).forEach((v) => expect(typeof v).toBe('string'));
  expect(logged()).toContain(label);
  expect(logged()).toContain('db.internal.example');
};

describe('podReadPointController', () => {
  const req = { params: { id: POD }, user: { _id: 'u1' }, body: { at: '2026-11-14T10:00:00.000Z' } };

  it('get: a PG failure answers fixed text and logs the cause', async () => {
    callerHasPodWriteAccess.mockResolvedValue(true);
    PodReadPoint.get.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await podReadPoint.getPodReadPoint(req, res);
    expectFixed500(out, 'getPodReadPoint');
    expect(out.body.msg).toBe('failed to read the read point');
  });

  it('set: a PG failure answers fixed text and logs the cause', async () => {
    callerHasPodWriteAccess.mockResolvedValue(true);
    PodReadPoint.markRead.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await podReadPoint.setPodReadPoint(req, res);
    expectFixed500(out, 'setPodReadPoint');
    expect(out.body.msg).toBe('failed to set the read point');
  });

  it('a refusal we wrote still passes through', async () => {
    callerHasPodWriteAccess.mockResolvedValue(false);
    const { res, out } = makeRes();
    await podReadPoint.getPodReadPoint(req, res);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ msg: 'not a member of this pod' });
  });
});

describe('threadStateController', () => {
  const req = { params: { messageId: '7' }, query: { podId: POD }, body: { collapsed: true, at: '2026-11-14T10:00:00.000Z' }, user: { _id: 'u1' } };

  it.each([
    ['followThread', 'failed to follow thread'],
    ['unfollowThread', 'failed to unfollow thread'],
    ['setThreadCollapsed', 'failed to set collapse state'],
    ['setThreadRead', 'failed to set read point'],
  ])('%s: a PG failure answers fixed text and logs the cause', async (name, msg) => {
    PGMessage.resolveId.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await threadState[name](req, res);
    expectFixed500(out, name);
    expect(out.body.msg).toBe(msg);
  });

  it('listThreadState: a PG failure answers fixed text and logs the cause', async () => {
    callerHasPodWriteAccess.mockResolvedValue(true);
    ThreadUserState.effectiveStateForPod.mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await threadState.listThreadState(req, res);
    expectFixed500(out, 'listThreadState');
    expect(out.body.msg).toBe('failed to list thread state');
  });

  it('a refusal we wrote still passes through', async () => {
    PGMessage.resolveId.mockResolvedValue(null);
    const { res, out } = makeRes();
    await threadState.followThread(req, res);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ msg: 'message not found' });
  });
});

describe('authController profile routes', () => {
  const select = () => ({ select: () => Promise.reject(new Error(DRIVER_TEXT)) });

  it.each([
    ['getProfile', 'getProfile'],
    ['getCurrentUser', 'getCurrentUser'],
  ])('%s: a Mongo failure answers fixed text and logs the cause', async (name, label) => {
    jest.spyOn(User, 'findById').mockImplementation(select);
    const { res, out } = makeRes();
    await authController[name]({ userId: 'u1' }, res);
    expectFixed500(out, label);
  });

  it('updateProfile: a Mongo failure answers fixed text and logs the cause', async () => {
    jest.spyOn(User, 'findById').mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await authController.updateProfile({ userId: 'u1', body: {} }, res);
    expectFixed500(out, 'updateProfile');
  });

  it('a 404 we wrote still passes through', async () => {
    jest.spyOn(User, 'findById').mockImplementation(() => ({ select: () => Promise.resolve(null) }));
    const { res, out } = makeRes();
    await authController.getProfile({ userId: 'u1' }, res);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: 'User not found' });
  });
});

describe('postController deletes', () => {
  it('deletePost: a Mongo failure answers fixed text and logs the cause', async () => {
    jest.spyOn(Post, 'findById').mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await postController.deletePost({ params: { id: 'p1' }, userId: 'u1' }, res);
    expectFixed500(out, 'deletePost');
  });

  it('deleteComment: a Mongo failure answers fixed text and logs the cause', async () => {
    jest.spyOn(Post, 'findById').mockRejectedValue(new Error(DRIVER_TEXT));
    const { res, out } = makeRes();
    await postController.deleteComment({ params: { id: 'p1', commentId: 'c1' }, userId: 'u1' }, res);
    expectFixed500(out, 'deleteComment');
  });

  it('a 404 we wrote still passes through', async () => {
    jest.spyOn(Post, 'findById').mockResolvedValue(null);
    const { res, out } = makeRes();
    await postController.deletePost({ params: { id: 'p1' }, userId: 'u1' }, res);
    expect(out.status).toBe(404);
    expect(out.body).toEqual({ error: 'Post not found' });
  });
});
