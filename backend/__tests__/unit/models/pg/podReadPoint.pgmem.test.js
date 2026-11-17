// A person's read point in a pod (first minute back): the shipped migration's
// table on pg-mem, so the forward-only rule is proved against the real DDL.
const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../../config/db-pg', () => ({ pool: mockPool }));

const PodReadPoint = require('../../../../models/pg/PodReadPoint');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

beforeAll(async () => {
  const ddl = fs.readFileSync(path.join(__dirname, '../../../../config/migrations/0014_pod_read_point.sql'), 'utf8');
  await mockPool.query(ddl);
});

it('has no read point before a visit is recorded', async () => {
  expect(await PodReadPoint.get('pod-a', 'u1')).toBeNull();
});

it('records the first visit and moves only forward', async () => {
  const first = iso(60_000);
  expect(await PodReadPoint.markRead('pod-a', 'u1', new Date(first))).toBe(first);
  const later = iso(30_000);
  expect(await PodReadPoint.markRead('pod-a', 'u1', new Date(later))).toBe(later);
  // An older write (a stale tab) changes nothing and returns the stored point.
  expect(await PodReadPoint.markRead('pod-a', 'u1', new Date(first))).toBe(later);
  expect(await PodReadPoint.get('pod-a', 'u1')).toBe(later);
});

it('clamps a point in the future to now', async () => {
  const before = Date.now();
  const stored = await PodReadPoint.markRead('pod-b', 'u1', new Date(Date.now() + 86_400_000));
  expect(new Date(stored).getTime()).toBeLessThanOrEqual(Date.now());
  expect(new Date(stored).getTime()).toBeGreaterThanOrEqual(before - 1000);
});

it('keeps each person and each pod apart', async () => {
  const at = iso(10_000);
  await PodReadPoint.markRead('pod-c', 'u1', new Date(at));
  expect(await PodReadPoint.get('pod-c', 'u2')).toBeNull();
  expect(await PodReadPoint.get('pod-d', 'u1')).toBeNull();
});
