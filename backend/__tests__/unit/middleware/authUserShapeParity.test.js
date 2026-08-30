const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// `middleware/auth.ts` dispatches on the token prefix and, until this test,
// the two branches left DIFFERENT shapes on `req.user`: the `cm_` API-token
// path assigned `{ id, username, email, role }`, the browser-JWT path assigned
// `{ id }`. Nothing errored — consumers just read `undefined`:
//
//   - `github.ts:146` refused genuine admins with `403 Admin only`
//   - registry publish/install persisted `publisher.name: undefined` (#1211)
//
// The bug is invisible to the suites that cover those routes, because their
// fake auth middleware injects `{ _id, role }` directly — i.e. the API-token
// shape. Only a test that drives the real middleware over a real browser JWT
// can see it, which is why it lives here rather than beside either consumer.

let mockLiveUser = null;
let mockApiTokenUser = null;

// The mock HONOURS the projection string. A `select()` that ignores its
// argument and hands back the whole row makes this suite fail open: narrowing
// the middleware's projection back to `.select('banned')` then leaves all
// seven tests green, because the fields arrive from the fixture rather than
// from the query. Verified by mutation — with the naive mock, that narrowing
// is invisible; with this one it reddens.
const project = (row, fields) => {
  if (!row) return row;
  const keys = String(fields).split(/\s+/).filter(Boolean);
  return Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));
};

jest.mock('../../../models/User', () => ({
  findOne: jest.fn(() => ({
    select: async (fields) => (
      mockApiTokenUser && { ...project(mockApiTokenUser, fields), _id: mockApiTokenUser._id }
    ),
  })),
  findById: jest.fn(() => ({
    select: (fields) => ({ lean: async () => project(mockLiveUser, fields) }),
  })),
  updateOne: jest.fn(() => Promise.resolve()),
}));

const authMiddleware = require('../../../middleware/auth');

const ID = new mongoose.Types.ObjectId();

const runWithJwt = async () => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  const token = jwt.sign({ id: ID.toString() }, process.env.JWT_SECRET);
  const req = { header: (h) => (h === 'Authorization' ? `Bearer ${token}` : null) };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return { req, res, next };
};

const runWithApiToken = async () => {
  const req = { header: (h) => (h === 'Authorization' ? 'Bearer cm_testtoken' : null) };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await authMiddleware(req, res, next);
  return { req, res, next };
};

describe('auth middleware: both token branches leave the same req.user shape', () => {
  beforeEach(() => {
    mockLiveUser = {
      banned: false, username: 'lily', email: 'lily@example.com', role: 'admin',
    };
    mockApiTokenUser = {
      _id: ID, username: 'lily', email: 'lily@example.com', role: 'admin', banned: false,
    };
  });

  it('the browser-JWT branch carries username, email and role', async () => {
    const { req, next } = await runWithJwt();
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({
      id: ID.toString(), username: 'lily', email: 'lily@example.com', role: 'admin',
    });
  });

  it('the two branches agree on the key set', async () => {
    const jwtReq = (await runWithJwt()).req;
    const apiReq = (await runWithApiToken()).req;
    // Fails closed in BOTH directions: narrowing the JWT branch reintroduces
    // the original defect, and widening only the API-token branch reintroduces
    // it for whatever field gets added next.
    expect(Object.keys(jwtReq.user).sort()).toEqual(Object.keys(apiReq.user).sort());
    expect(jwtReq.user).toEqual(apiReq.user);
  });

  it('the github.ts:146 predicate now admits a browser-session admin', async () => {
    const { req } = await runWithJwt();
    // Verbatim the consumer's own test, not a paraphrase of it.
    expect(req.user?.role !== 'admin').toBe(false);
  });

  it('CONTROL: the predicate still refuses a browser-session non-admin', async () => {
    // Without this, the test above would pass just as well against a
    // middleware that hardcoded `role: 'admin'` for everyone.
    mockLiveUser = {
      banned: false, username: 'mallory', email: 'm@example.com', role: 'member',
    };
    const { req } = await runWithJwt();
    expect(req.user?.role !== 'admin').toBe(true);
  });

  it('a user row without a role leaves role undefined, not defaulted', async () => {
    // Absence must stay absent: a default here would grant or deny on data the
    // row does not contain.
    mockLiveUser = { banned: false, username: 'nobody' };
    const { req } = await runWithJwt();
    expect(req.user.role).toBeUndefined();
    expect(req.user.username).toBe('nobody');
  });

  it('the ban check still fires on the same widened read', async () => {
    mockLiveUser = { banned: true, username: 'lily', role: 'admin' };
    const { res, next } = await runWithJwt();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('a deleted account is still refused', async () => {
    mockLiveUser = null;
    const { res, next } = await runWithJwt();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
