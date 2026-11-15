// GET/PUT /api/pods/:id/read-point: only a member reads or moves their own
// point, `at` must be a real ISO date-time, and no other person's point is
// ever reachable (the caller's id comes from auth, never from the request).
jest.mock('../../../models/pg/PodReadPoint', () => ({ get: jest.fn(), markRead: jest.fn() }));
jest.mock('../../../services/podWriteAccessService', () => ({
  getCallerId: (req) => String(req.user?._id || req.userId || ''),
  callerHasPodWriteAccess: jest.fn(),
}));
jest.mock('../../../services/podReadPointSeed', () => ({ seedPodReadPoint: jest.fn() }));
const PodReadPoint = require('../../../models/pg/PodReadPoint');
const { seedPodReadPoint } = require('../../../services/podReadPointSeed');
const { callerHasPodWriteAccess } = require('../../../services/podWriteAccessService');
const { getPodReadPoint, setPodReadPoint } = require('../../../controllers/podReadPointController');

const POD = '0123456789abcdef01234567';
const res = () => { const r = { status: jest.fn(() => r), json: jest.fn() }; return r; };

beforeEach(() => jest.clearAllMocks());

it('refuses a caller with no identity', async () => {
  const r = res();
  await getPodReadPoint({ params: { id: POD } }, r);
  expect(r.status).toHaveBeenCalledWith(401);
});

it('refuses a non-member and reads nothing', async () => {
  callerHasPodWriteAccess.mockResolvedValue(false);
  const r = res();
  await getPodReadPoint({ params: { id: POD }, user: { _id: 'u1' } }, r);
  expect(r.status).toHaveBeenCalledWith(403);
  expect(PodReadPoint.get).not.toHaveBeenCalled();
});

it('returns the member\'s own point, read by their auth id', async () => {
  callerHasPodWriteAccess.mockResolvedValue(true);
  PodReadPoint.get.mockResolvedValue('2026-11-14T10:00:00.000Z');
  const r = res();
  await getPodReadPoint({ params: { id: POD }, user: { _id: 'u1' }, query: { userId: 'someone-else' } }, r);
  expect(PodReadPoint.get).toHaveBeenCalledWith(POD, 'u1');
  expect(r.status).toHaveBeenCalledWith(200);
  expect(r.json).toHaveBeenCalledWith({ podId: POD, lastReadAt: '2026-11-14T10:00:00.000Z' });
});

it('seeds a first point from the member\'s activity in the pod when none exists, never last-active', async () => {
  callerHasPodWriteAccess.mockResolvedValue(true);
  PodReadPoint.get.mockResolvedValue(null);
  seedPodReadPoint.mockResolvedValue('2026-11-12T09:00:00.000Z');
  const r = res();
  await getPodReadPoint({ params: { id: POD }, user: { _id: 'u1' } }, r);
  expect(seedPodReadPoint).toHaveBeenCalledWith({ podId: POD, userId: 'u1' });
  expect(r.json).toHaveBeenCalledWith({ podId: POD, lastReadAt: '2026-11-12T09:00:00.000Z' });
});

it('does not seed over a point that exists', async () => {
  callerHasPodWriteAccess.mockResolvedValue(true);
  PodReadPoint.get.mockResolvedValue('2026-11-14T10:00:00.000Z');
  await getPodReadPoint({ params: { id: POD }, user: { _id: 'u1' } }, res());
  expect(seedPodReadPoint).not.toHaveBeenCalled();
});

it('a failed seed still answers, with no point, so the pod opens at its end', async () => {
  callerHasPodWriteAccess.mockResolvedValue(true);
  PodReadPoint.get.mockResolvedValue(null);
  seedPodReadPoint.mockRejectedValue(new Error('pg down'));
  const r = res();
  await getPodReadPoint({ params: { id: POD }, user: { _id: 'u1' } }, r);
  expect(r.status).toHaveBeenCalledWith(200);
  expect(r.json).toHaveBeenCalledWith({ podId: POD, lastReadAt: null });
});

it.each([[undefined], ['yesterday'], ['2026-02-30T10:00:00Z'], [1731578400000]])('a PUT with at=%p is a 400 before any read', async (at) => {
  const r = res();
  await setPodReadPoint({ params: { id: POD }, user: { _id: 'u1' }, body: { at } }, r);
  expect(r.status).toHaveBeenCalledWith(400);
  expect(callerHasPodWriteAccess).not.toHaveBeenCalled();
  expect(PodReadPoint.markRead).not.toHaveBeenCalled();
});

it('a non-member cannot move a point', async () => {
  callerHasPodWriteAccess.mockResolvedValue(false);
  const r = res();
  await setPodReadPoint({ params: { id: POD }, user: { _id: 'u1' }, body: { at: '2026-11-14T10:00:00Z' } }, r);
  expect(r.status).toHaveBeenCalledWith(403);
  expect(PodReadPoint.markRead).not.toHaveBeenCalled();
});

it('a member moves their own point and gets the stored one back', async () => {
  callerHasPodWriteAccess.mockResolvedValue(true);
  PodReadPoint.markRead.mockResolvedValue('2026-11-14T10:00:00.000Z');
  const r = res();
  await setPodReadPoint({ params: { id: POD }, user: { _id: 'u1' }, body: { at: '2026-11-14T10:00:00Z', userId: 'someone-else' } }, r);
  expect(PodReadPoint.markRead).toHaveBeenCalledWith(POD, 'u1', new Date('2026-11-14T10:00:00Z'));
  expect(r.json).toHaveBeenCalledWith({ podId: POD, lastReadAt: '2026-11-14T10:00:00.000Z' });
});
